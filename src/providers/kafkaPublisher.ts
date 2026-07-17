import { Kafka, logLevel, type Producer } from 'kafkajs';
import type { Config } from '../config.js';
import type { EventPublisher, PublishableEvent } from './types.js';

/**
 * Kafka / RocketMQ publisher (memo §10/§11): fans the run-event outbox out to a
 * Kafka topic. One message per event, keyed by `event.key` (the run id) so a
 * run's events stay ordered within a partition. Works with any Kafka-compatible
 * broker — a local broker in dev, or a managed BytePlus Message Queue for Kafka
 * cluster (public endpoint = SASL/PLAIN over SSL). The producer connects lazily
 * and is reused; the outbox relay already guarantees at-least-once + de-dup.
 */
export class KafkaPublisher implements EventPublisher {
  private producer: Producer | null = null;
  private readonly topic: string;

  constructor(private readonly cfg: Config) {
    if (!cfg.KAFKA_BROKERS) {
      throw new Error('KAFKA_BROKERS is required when PUBLISHER=kafka');
    }
    this.topic = cfg.KAFKA_TOPIC;
  }

  private async connect(): Promise<Producer> {
    if (this.producer) return this.producer;
    const kafka = new Kafka({
      clientId: 'managed-agents-relay',
      brokers: this.cfg.KAFKA_BROKERS!.split(',').map((b) => b.trim()),
      ssl:
        this.cfg.KAFKA_SSL === 1
          ? { rejectUnauthorized: this.cfg.KAFKA_SSL_REJECT_UNAUTHORIZED === 1 }
          : false,
      sasl:
        this.cfg.KAFKA_SASL_USERNAME && this.cfg.KAFKA_SASL_PASSWORD
          ? {
              mechanism: 'plain',
              username: this.cfg.KAFKA_SASL_USERNAME,
              password: this.cfg.KAFKA_SASL_PASSWORD,
            }
          : undefined,
      logLevel: logLevel.ERROR,
    });
    const producer = kafka.producer({ allowAutoTopicCreation: false });
    await producer.connect();
    this.producer = producer;
    return producer;
  }

  async publish(events: PublishableEvent[]): Promise<void> {
    if (events.length === 0) return;
    const producer = await this.connect();
    await producer.send({
      topic: this.topic,
      messages: events.map((e) => ({
        key: e.key,
        value: JSON.stringify({ id: e.id, topic: e.topic, ...e.payload }),
      })),
    });
  }

  async close(): Promise<void> {
    await this.producer?.disconnect().catch(() => {});
    this.producer = null;
  }
}
