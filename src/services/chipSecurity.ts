// src/services/chipSecurity.ts
// Security layer for Chip AI Caddy
// Handles: input sanitisation, content moderation, response validation, rate limiting
//
// SECURITY REQUIREMENTS:
// - All Claude API calls happen server-side only
// - System prompt is hardcoded server-side, never exposed to clients
// - User messages sanitised before reaching Claude
// - Response validated before sending to user

// ============================================
// INPUT SANITISATION
// ============================================

/**
 * Patterns that indicate prompt injection attempts.
 * These are stripped or flagged before messages reach Claude.
 */
const INJECTION_PATTERNS: RegExp[] = [
  /\b(system\s*:|assistant\s*:|human\s*:)/gi,
  /\b(ignore\s+(your|all|previous|prior)\s+(instructions?|rules?|guidelines?|prompt))/gi,
  /\b(you\s+are\s+now\b)/gi,
  /\b(pretend\s+(to\s+be|you\s*'?re?))/gi,
  /\b(act\s+as\s+(if|though|a\s+different))/gi,
  /\b(forget\s+(your|all|everything|previous))/gi,
  /\b(override\s+(your|the|all)\s+(instructions?|rules?|guidelines?))/gi,
  /\b(reveal\s+(your|the)\s+(system\s*)?prompt)/gi,
  /\b(what\s+(is|are)\s+your\s+(system\s*)?instructions?)/gi,
  /\b(show\s+me\s+your\s+(system\s*)?prompt)/gi,
  /\b(repeat\s+(your|the)\s+(system\s*)?prompt)/gi,
  /\b(disregard\s+(all|your|previous))/gi,
  /\b(jailbreak)/gi,
  /\b(DAN\s+mode)/gi,
  /\b(do\s+anything\s+now)/gi,
  /\[\s*INST\s*\]/gi,
  /<<\s*SYS\s*>>/gi,
];

/**
 * Offensive content patterns for basic content moderation.
 * Returns true if the message contains obvious abuse.
 */
const ABUSE_PATTERNS: RegExp[] = [
  // Slurs and hate speech patterns — keeping this minimal and focused
  /\b(kys|kill\s+yourself)\b/gi,
  /\b(f+u+c+k+\s+you)\b/gi,
  /\b(die\s+in\s+a)\b/gi,
];

export interface SanitisationResult {
  sanitised: string;
  wasModified: boolean;
  injectionAttempt: boolean;
  flaggedPatterns: string[];
}

/**
 * Sanitise user input before passing to Claude.
 * Strips injection attempts and flags suspicious content.
 */
export function sanitiseUserMessage(rawMessage: string): SanitisationResult {
  let sanitised = rawMessage.trim();
  const flaggedPatterns: string[] = [];
  let injectionAttempt = false;

  // Check for injection patterns
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(sanitised)) {
      const match = sanitised.match(pattern);
      if (match) {
        flaggedPatterns.push(match[0]);
      }
      sanitised = sanitised.replace(pattern, '[removed]');
      injectionAttempt = true;
    }
    // Reset lastIndex for global regexps
    pattern.lastIndex = 0;
  }

  return {
    sanitised,
    wasModified: sanitised !== rawMessage.trim(),
    injectionAttempt,
    flaggedPatterns,
  };
}

/**
 * Check if a message contains abusive or harmful content.
 * Returns true if the message should be rejected.
 */
export function isAbusiveContent(message: string): boolean {
  for (const pattern of ABUSE_PATTERNS) {
    if (pattern.test(message)) {
      pattern.lastIndex = 0;
      return true;
    }
    pattern.lastIndex = 0;
  }
  return false;
}

// ============================================
// RESPONSE VALIDATION
// ============================================

/**
 * Patterns in Claude's response that suggest system prompt leakage
 * or other unintended output.
 */
const RESPONSE_LEAK_PATTERNS: RegExp[] = [
  /\bsystem\s*prompt\s*:/gi,
  /\bmy\s+instructions\s+(are|say|tell)\b/gi,
  /\bI\s+was\s+told\s+to\b/gi,
  /SELECT\s+.+\s+FROM\s+/gi,
  /INSERT\s+INTO\s+/gi,
  /DELETE\s+FROM\s+/gi,
  /UPDATE\s+.+\s+SET\s+/gi,
  /process\.env\./gi,
  /ANTHROPIC_API_KEY/gi,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
];

export interface ResponseValidationResult {
  clean: string;
  wasModified: boolean;
  leakDetected: boolean;
}

/**
 * Validate Claude's response before sending to the user.
 * Strips any content that looks like prompt leakage or raw data.
 */
export function validateResponse(rawResponse: string): ResponseValidationResult {
  let clean = rawResponse;
  let leakDetected = false;

  for (const pattern of RESPONSE_LEAK_PATTERNS) {
    if (pattern.test(clean)) {
      clean = clean.replace(pattern, '[...]');
      leakDetected = true;
    }
    pattern.lastIndex = 0;
  }

  return {
    clean,
    wasModified: clean !== rawResponse,
    leakDetected,
  };
}

// ============================================
// MESSAGE SIZE LIMITS & BUDGETS
// ============================================

export const MAX_USER_MESSAGE_LENGTH = 1000;
export const MAX_CONVERSATION_HISTORY = 20; // messages sent to Claude
export const MAX_RESPONSE_TOKENS = 250;
export const DAILY_MESSAGE_LIMIT = 30;
export const DAILY_TOKEN_BUDGET = 50_000; // total tokens per user per day
export const MAX_CONVERSATIONS_PER_USER = 50;

// ============================================
// SYSTEM PROMPT VERSIONING
// ============================================

/**
 * Tracks the version of the Chip system prompt.
 * Stored with every message in chip_messages.metadata for debugging.
 * Increment when you change CHIP_SYSTEM_PROMPT in chipService.ts.
 */
export const CHIP_PROMPT_VERSION = '1.0';

// ============================================
// REJECTION MESSAGES
// ============================================

/**
 * Golf-themed rejection messages for various scenarios.
 */
export const REJECTION_MESSAGES = {
  rateLimited:
    "You've used all 30 messages for today — come back tomorrow for more! In the meantime, check out your recommendations on the Caddy Hub.",
  tokenBudgetExceeded:
    "Chip's had a full day on the course — he needs a breather. Come back tomorrow for more advice!",
  messageTooLong:
    "That's a longer read than the R&A rulebook! Keep it under 1,000 characters and I'll do my best.",
  abusiveContent:
    "Let's keep it about golf, yeah? I'm here to help you find the right kit.",
  serverError:
    "Chip's on the back nine — give him a minute and try again.",
  serviceDown:
    "Chip's gone to the clubhouse — try again shortly.",
  unreadableImage:
    "I couldn't read that clearly — can you try another screenshot? Make sure the numbers are visible.",
  maxConversations:
    "You've got a full card of chats! Delete some old conversations to start new ones.",
} as const;
