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

export const models = {
  GuildSettings,
  UserSettings,
  LanguageOverride,
  AuditLog,
};

/** Collections planned for later phases (declared so the roadmap is explicit). */
export const PLANNED_MODELS = Object.freeze([
  'MemberProfile',
  'MemberCard',
  'WelcomeConfig',
  'GoodbyeConfig',
  'TemporaryVoice',
  'BoosterRecord',
  'Ticket',
  'TicketMessage',
  'AnonymousSubmission',
  'Streak',
  'XPRecord',
  'EconomyAccount',
  'Inventory',
  'Achievement',
  'Warning',
  'ModerationCase',
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

export { GuildSettings, UserSettings, LanguageOverride, AuditLog };
export { AUDIT_TYPES } from './AuditLog.js';
export default models;
