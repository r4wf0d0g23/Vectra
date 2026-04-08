/**
 * Transport abstraction — every channel connector implements this interface.
 * Vectra core depends on this interface, never on Discord/Signal specifics.
 *
 * The harness operates in terms of InboundMessage and OutboundMessage.
 * Each transport implementation (Discord, Signal, CLI, webhook) adapts
 * its native message format to these types and vice versa.
 *
 * Lifecycle:
 *   1. Instantiate via TransportFactory.create(config)
 *   2. Register handlers: onMessage, onConnect, onDisconnect, onError
 *   3. Call connect() — handlers fire as events arrive
 *   4. Call send() to push outbound messages
 *   5. Call disconnect() on shutdown
 */

export interface InboundMessage {
  id: string;
  channelId: string;
  senderId: string;
  senderTrust: 'human' | 'cron' | 'subagent' | 'webhook';
  text: string;
  timestamp: Date;
  replyToId?: string;
  attachments?: Array<{ type: string; url: string; }>;
  raw: unknown; // original platform message object
}

export interface OutboundMessage {
  channelId: string;
  text: string;
  replyToId?: string;
  attachments?: Array<{ type: string; url: string; path?: string; }>;
}

export interface TransportConnector {
  /** Connect to the channel and start receiving messages */
  connect(): Promise<void>;

  /** Disconnect cleanly */
  disconnect(): Promise<void>;

  /** Send a message to a channel */
  send(message: OutboundMessage): Promise<void>;

  /** Register handler for inbound messages */
  onMessage(handler: (message: InboundMessage) => Promise<void>): void;

  /** Register handler for connection events */
  onConnect(handler: () => void): void;
  onDisconnect(handler: (reason: string) => void): void;
  onError(handler: (error: Error) => void): void;

  /** Health check */
  isConnected(): boolean;
}

export interface TransportFactory {
  create(config: Record<string, unknown>): TransportConnector;
}
