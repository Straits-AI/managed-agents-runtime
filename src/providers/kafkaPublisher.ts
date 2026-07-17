import type { EventPublisher, PublishableEvent } from './types.js';

/**
 * Kafka / RocketMQ publisher — SEAM, not wired (memo §10/§11 maps event
 * transport to Kafka or RocketMQ).
 *
 * Fanning events out to a real broker needs three things this repo intentionally
 * does not carry yet:
 *   1. a broker client dependency (e.g. `kafkajs`);
 *   2. a provisioned BytePlus message-queue instance + connection config
 *      (brokers, credentials, topic) — a billable cloud resource whose regional
 *      availability must be confirmed first;
 *   3. topic/partitioning + serialization decisions.
 *
 * To implement: add the client, connect in the constructor, and in `publish`
 * produce one message per event to `KAFKA_TOPIC`, keyed by `event.key` (the run
 * id) so a run's events stay ordered within a partition. The outbox relay
 * already guarantees at-least-once delivery and de-dupes across relays, so the
 * adapter only needs to produce.
 *
 * Until implemented it throws, so selecting PUBLISHER=kafka fails loudly rather
 * than silently dropping events in production.
 */
export class KafkaPublisher implements EventPublisher {
  async publish(_events: PublishableEvent[]): Promise<void> {
    throw new Error(
      'KafkaPublisher is a seam: add a broker client + provision a queue and ' +
        'implement publish() before setting PUBLISHER=kafka (see src/providers/kafkaPublisher.ts)',
    );
  }
}
