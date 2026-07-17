import type { EventPublisher, PublishableEvent } from '../types.js';
import { log } from '../../log.js';

const plog = log.child({ component: 'publisher', publisher: 'inproc' });

/**
 * Default publisher: a no-op drain. It marks outbox rows published (so the
 * table doesn't grow unbounded) and logs each event at debug. Consumers read
 * the durable event ledger via the API; this is the seam a Kafka/RocketMQ
 * adapter replaces to fan events out to external subscribers.
 */
export class InProcessPublisher implements EventPublisher {
  async publish(events: PublishableEvent[]): Promise<void> {
    for (const e of events) {
      plog.debug('event', { id: e.id, topic: e.topic, key: e.key });
    }
  }
}
