/**
 * src/handlers/moduleLoader.js
 * ---------------------------------------------------------------------------
 * Plugin / feature-module manager.
 *
 * A module is a folder under `src/bot/modules/<name>/` exporting
 * `index.js` (or `module.js`) with:
 *
 *   export default {
 *     name: 'welcome',
 *     version: '1.0.0',
 *     phase: 2,
 *     dependencies: ['core'],
 *     configKey: 'welcome',          // GuildSettings.moduleToggles key
 *     async init(ctx) { … },          // wire listeners, load caches
 *     async start(ctx) { … },         // begin background work
 *     async stop(ctx) { … },          // release resources
 *   };
 *
 * The manager resolves dependencies (topological order, cycle detection),
 * tracks lifecycle state per module and reports it on `/health` and in
 * `/settings`. A module that fails to boot is isolated: the rest of the bot
 * keeps running and the failure is visible instead of silent.
 */

import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { ValidationError, ConflictError } from '../utils/errors.js';
import { getLogger } from '../utils/logger.js';

export const MODULE_STATES = Object.freeze({
  DISCOVERED: 'discovered',
  INITIALIZED: 'initialized',
  RUNNING: 'running',
  DISABLED: 'disabled',
  FAILED: 'failed',
});

export class ModuleManager {
  /** @param {object} [deps] @param {import('../utils/logger.js').Logger} [deps.logger] */
  constructor(deps = {}) {
    this.logger = (deps.logger ?? getLogger()).child('modules');
    /** @type {Map<string, { definition:any, state:string, error:string|null, phase:number, dependencies:string[] }>} */
    this.modules = new Map();
    /** @type {Map<string, import('../bot/client.js').default>} */
    this.contexts = new Map();
    this.bootOrder = [];
  }

  /**
   * Discover modules on disk.
   * @param {string} directory
   */
  async discover(directory) {
    const entries = await readdir(directory, { withFileTypes: true }).catch((err) => {
      if (err.code === 'ENOENT') return [];
      throw err;
    });

    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    for (const dir of dirs) {
      const base = join(directory, dir);
      const rel = relative(process.cwd(), base);
      let entryFile = null;
      for (const candidate of ['index.js', 'module.js']) {
        try {
          const files = await readdir(base);
          if (files.includes(candidate)) {
            entryFile = join(base, candidate);
            break;
          }
        } catch {
          /* unreadable module folder */
        }
      }
      if (!entryFile) {
        this.logger.warn('Module folder has no index.js/module.js — skipped', { module: dir, path: rel });
        continue;
      }
      try {
        const mod = await import(`file://${entryFile}`);
        const definition = mod.default ?? mod;
        this.register(definition, rel);
      } catch (err) {
        this.logger.errorFrom(err, 'Failed to import module', { module: dir });
        this.modules.set(dir, {
          definition: { name: dir },
          state: MODULE_STATES.FAILED,
          error: err.message,
          phase: Number.POSITIVE_INFINITY,
          dependencies: [],
        });
      }
    }

    this.bootOrder = this.resolveOrder();
    this.logger.info('Modules discovered', {
      count: this.modules.size,
      order: this.bootOrder,
    });
    return [...this.modules.keys()];
  }

  /**
   * Register one module definition (also used by tests).
   * @param {object} definition
   * @param {string} [file]
   */
  register(definition, file = '<inline>') {
    if (!definition || typeof definition !== 'object') {
      throw new ValidationError(`module "${file}" does not export an object`);
    }
    if (typeof definition.name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(definition.name)) {
      throw new ValidationError(`module "${file}" has an invalid name "${definition.name}" (kebab-case required)`);
    }
    if (this.modules.has(definition.name)) {
      throw new ConflictError(`module "${definition.name}" is registered twice`);
    }
    for (const hook of ['init', 'start', 'stop']) {
      if (definition[hook] !== undefined && typeof definition[hook] !== 'function') {
        throw new ValidationError(`module "${definition.name}" declares "${hook}" but it is not a function`);
      }
    }
    this.modules.set(definition.name, {
      definition,
      state: MODULE_STATES.DISCOVERED,
      error: null,
      phase: definition.phase ?? 0,
      dependencies: definition.dependencies ?? [],
    });
    // Keep the reported order in sync for modules registered programmatically
    // (tests, dynamic plugins) — not just those found by discover().
    try {
      this.bootOrder = this.resolveOrder();
    } catch {
      // A cycle/unknown dependency is reported by resolveOrder() callers;
      // keep the previous order rather than throwing from register().
    }
    return this.modules.get(definition.name);
  }

  /**
   * Topological order: dependencies first, then by declared phase, then name.
   * @returns {string[]}
   * @throws {ConflictError} on a dependency cycle or unknown dependency
   */
  resolveOrder() {
    const visited = new Set();
    const visiting = new Set();
    const order = [];

    const visit = (name, trail) => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        throw new ConflictError(`Module dependency cycle detected: ${[...trail, name].join(' -> ')}`);
      }
      const entry = this.modules.get(name);
      if (!entry) {
        throw new ConflictError(`Module "${trail[trail.length - 1]}" depends on unknown module "${name}"`);
      }
      visiting.add(name);
      for (const dep of entry.dependencies) visit(dep, [...trail, name]);
      visiting.delete(name);
      visited.add(name);
      order.push(name);
    };

    const names = [...this.modules.keys()].sort((a, b) => {
      const pa = this.modules.get(a).phase;
      const pb = this.modules.get(b).phase;
      if (pa !== pb) return pa - pb;
      return a.localeCompare(b);
    });
    for (const name of names) visit(name, []);
    return order;
  }

  /**
   * Boot every module in dependency order.
   * @param {object} ctx shared context: { client, config, settings, i18n, logger }
   * @param {object} [options]
   * @param {boolean} [options.start] also call start() (default true)
   * @returns {Promise<{ started:string[], disabled:string[], failed:{ name:string, error:string }[] }>}
   */
  async boot(ctx, options = {}) {
    const started = [];
    const disabled = [];
    const failed = [];
    const shouldStart = options.start ?? true;

    for (const name of this.resolveOrder()) {
      const entry = this.modules.get(name);
      const { definition } = entry;
      const moduleCtx = { ...ctx, moduleName: name, logger: this.logger.child(name) };
      this.contexts.set(name, moduleCtx);

      try {
        if (definition.init) await definition.init(moduleCtx);
        entry.state = MODULE_STATES.INITIALIZED;

        if (!shouldStart || !definition.start) {
          started.push(name);
          continue;
        }
        await definition.start(moduleCtx);
        entry.state = MODULE_STATES.RUNNING;
        started.push(name);
        this.logger.info('Module running', { module: name, version: definition.version ?? '0.0.0' });
      } catch (err) {
        entry.state = MODULE_STATES.FAILED;
        entry.error = err.message;
        failed.push({ name, error: err.message });
        this.logger.errorFrom(err, 'Module failed to boot', { module: name });
      }
    }

    return { started, disabled, failed };
  }

  /**
   * Stop every running module in reverse order. Never throws.
   * @param {object} [ctx]
   */
  async shutdown(ctx = {}) {
    const stopped = [];
    for (const name of [...this.bootOrder].reverse()) {
      const entry = this.modules.get(name);
      if (!entry || entry.state === MODULE_STATES.FAILED) continue;
      try {
        if (entry.definition.stop) await entry.definition.stop(this.contexts.get(name) ?? ctx);
        stopped.push(name);
      } catch (err) {
        this.logger.errorFrom(err, 'Module failed to stop', { module: name });
      } finally {
        entry.state = MODULE_STATES.DISCOVERED;
      }
    }
    this.logger.info('Modules stopped', { stopped });
    return stopped;
  }

  /** @returns {{ name:string, state:string, version:string, phase:number, dependencies:string[], error:string|null }[]} */
  status() {
    let order = this.bootOrder;
    try {
      order = this.resolveOrder();
      this.bootOrder = order;
    } catch {
      /* an invalid graph is surfaced by boot()/resolveOrder(); report what we have */
    }
    return order.map((name) => {
      const entry = this.modules.get(name);
      if (!entry) return { name, state: MODULE_STATES.DISCOVERED, version: '0.0.0', phase: 0, dependencies: [], error: 'missing module' };
      return {
        name,
        state: entry.state,
        version: entry.definition.version ?? '0.0.0',
        phase: entry.phase,
        dependencies: entry.dependencies,
        error: entry.error,
      };
    });
  }

  /** @param {string} name */
  get(name) {
    return this.modules.get(name)?.definition ?? null;
  }

  /** @returns {number} */
  get size() {
    return this.modules.size;
  }
}

export const moduleManager = new ModuleManager();

export default moduleManager;
