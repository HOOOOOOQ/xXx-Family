/**
 * src/database/models/index.js
 * ---------------------------------------------------------------------------
 * Model registry.
 *
 * Importing this module registers every collection exactly once and gives the
 * rest of the app a single import surface:
 *
 *     import { GuildSettings } from '../database/models/index.js';
 *
 * Phase 1 ships the collections the language system needs. Every later phase
 * adds its own model file and one line here.
 */

import GuildSettings from './GuildSettings.js';
import UserSettings from './UserSettings.js';
import LanguageOverride from './LanguageOverride.js';
import AuditLog from './AuditLog.js';
import WelcomeConfig from './WelcomeConfig.js';
import GoodbyeConfig from './GoodbyeConfig.js';
import BoosterConfig from './BoosterConfig.js';
import BoosterRecord from './BoosterRecord.js';
import ModerationCase from './ModerationCase.js';
import Counter from './Counter.js';
import TempVoiceConfig from './TempVoiceConfig.js';
import TemporaryVoice from './TemporaryVoice.js';

export const models = {
  GuildSettings,
  UserSettings,
  LanguageOverride,
  AuditLog,
  WelcomeConfig,
  GoodbyeConfig,
  BoosterConfig,
  BoosterRecord,
  ModerationCase,
  Counter,
  TempVoiceConfig,
  TemporaryVoice,
};

/** Collections planned for later phases (declared so the roadmap is explicit). */
export const PLANNED_MODELS = Object.freeze([
  'MemberProfile',
  'MemberCard',
  'Ticket',
  'TicketMessage',
  'AnonymousSubmission',
  'Streak',
  'XPRecord',
  'EconomyAccount',
  'Inventory',
  'Achievement',
  'AutomodConfig',
  'CustomTag',
  'Announcement',
  'Reminder',
  'Giveaway',
  'AIConversation',
  'AIUsage',
  'GameSession',
  'DashboardSession',
  'ScheduledTask',
]);

export {
  GuildSettings,
  UserSettings,
  LanguageOverride,
  AuditLog,
  WelcomeConfig,
  GoodbyeConfig,
  BoosterConfig,
  BoosterRecord,
  ModerationCase,
  Counter,
  TempVoiceConfig,
  TemporaryVoice,
};
export { CASE_TYPES, TEMPORARY_TYPES } from './ModerationCase.js';
export { COUNTER_SCOPES } from './Counter.js';
export { DEFAULT_TEMPVOICE_CONFIG, toEffective as toEffectiveTempVoice } from './TempVoiceConfig.js';
export { AUDIT_TYPES } from './AuditLog.js';
export default models;
