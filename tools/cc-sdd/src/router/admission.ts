import { DatabaseSync } from 'node:sqlite';

export interface AdmissionConfig {
  whitelistSenders: string[];
  botSenders: string[];
  proactiveMode: 'off' | 'observe' | 'auto';
  agentMentionHandle: string;
}

export interface IncomingEvent {
  id: string;
  sender: string;
  content: string;
  threadId: string;
  eventType?: string;
}

export interface AdmissionDecision {
  classification: 'explicit' | 'inferred' | 'ignore';
  action: 'CREATE_TICKET' | 'LOG_CANDIDATE_ONLY' | 'DROP_SILENTLY';
  tokensConsumed: number;
}

export class AdmissionGate {
  constructor(
    private db: DatabaseSync,
    private config: AdmissionConfig
  ) {}

  evaluateAdmission(event: IncomingEvent): AdmissionDecision {
    const isWhitelisted = this.config.whitelistSenders.includes(event.sender);
    const isBot = this.config.botSenders.includes(event.sender);

    // 1. Unknown senders are ignored with 0 LLM tokens
    if (!isWhitelisted && !isBot) {
      return {
        classification: 'ignore',
        action: 'DROP_SILENTLY',
        tokensConsumed: 0,
      };
    }

    // 2. Whitelisted sender with explicit @Agent mention
    if (isWhitelisted && event.content.includes(this.config.agentMentionHandle)) {
      return {
        classification: 'explicit',
        action: 'CREATE_TICKET',
        tokensConsumed: 0,
      };
    }

    // 3. Inferred candidates (bots or whitelist without explicit mention)
    const classification = 'inferred';

    switch (this.config.proactiveMode) {
      case 'off':
        return {
          classification,
          action: 'DROP_SILENTLY',
          tokensConsumed: 0,
        };

      case 'observe': {
        const now = new Date().toISOString();
        this.db
          .prepare(
            'INSERT OR REPLACE INTO triggers (id, source_id, thread_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)'
          )
          .run(event.id, event.sender, event.threadId, 'INFERRED_CANDIDATE', event.content, now);

        return {
          classification,
          action: 'LOG_CANDIDATE_ONLY',
          tokensConsumed: 0,
        };
      }

      case 'auto':
        return {
          classification,
          action: 'CREATE_TICKET',
          tokensConsumed: 0,
        };
    }
  }
}
