import "server-only";

import { Queue, QueueOptions } from "bullmq";

import { redis } from "@/lib/redis";

/**
 * BullMQ queues for background work.
 *
 * `monitor` carries two job kinds:
 *  - "sweep": finds subscriptions whose nextCheckAt is due and enqueues checks
 *  - "check": performs a single product check for one subscription
 *
 * Using a single queue keeps worker wiring simple; per-retailer rate limiting
 * is handled by the check worker via adapter concurrency limits.
 */
export const MONITOR_QUEUE = "monitor";

const queueOptions: QueueOptions = {
  connection: redis,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: { age: 60 * 60, count: 500 },
    removeOnFail: { age: 24 * 60 * 60, count: 2000 },
  },
};

const globalForQueues = globalThis as unknown as {
  queues?: Record<string, Queue>;
};

function createQueue(name: string): Queue {
  return new Queue(name, queueOptions);
}

function getQueues(): Record<string, Queue> {
  if (!globalForQueues.queues) {
    globalForQueues.queues = {};
  }
  if (!globalForQueues.queues[MONITOR_QUEUE]) {
    globalForQueues.queues[MONITOR_QUEUE] = createQueue(MONITOR_QUEUE);
  }
  return globalForQueues.queues;
}

export function getQueue(name: string): Queue {
  const queues = getQueues();
  return queues[name];
}

export const monitorQueue: Queue = getQueue(MONITOR_QUEUE);
