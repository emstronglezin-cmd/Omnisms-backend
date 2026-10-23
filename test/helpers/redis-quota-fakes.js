'use strict';
/**
 * Fakes ioredis + bullmq pour les tests quota Redis — installés dans
 * require.cache AVANT tout require de services/queueService.
 * Contrôle via global.__FAKES (compteurs + déclencheurs).
 */
function installFakes() {
  const { EventEmitter } = require('events');
  const F = (global.__FAKES = {
    redisInstances: [],
    pingCount: 0,
    disconnectCount: 0,
    quotaMode: false, // ping lève l'erreur quota si true
    added: [],        // jobs ajoutés via FakeQueue
    addError: null,
    workers: [],      // FakeWorker créés
    closedWorkers: 0,
    closedQueues: 0,
  });

  class FakeRedis extends EventEmitter {
    constructor(url, opts) {
      super();
      this.url = url;
      this.opts = opts || {};
      this.status = 'connecting';
      F.redisInstances.push(this);
      setImmediate(() => {
        if (F.failConnect) this.emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
        else { this.status = 'ready'; this.emit('ready'); }
      });
    }
    async ping() {
      F.pingCount++;
      if (F.quotaMode) throw new Error('ERR max requests limit exceeded. Limit: 500000, Usage: 500000');
      return 'PONG';
    }
    disconnect() { F.disconnectCount++; this.status = 'end'; }
    quit() { F.disconnectCount++; this.status = 'end'; }
  }

  class FakeQueue {
    constructor(name, opts) { this.name = name; this.opts = opts; }
    async add(name, data, o) {
      F.added.push({ name, data, o });
      if (F.addError) throw F.addError;
      return { id: `job-${F.added.length}` };
    }
    async close() { F.closedQueues++; }
  }

  class FakeWorker extends EventEmitter {
    constructor(name, processor, opts) {
      super();
      this.name = name;
      this.processor = processor;
      this.opts = opts;
      F.workers.push(this);
    }
    async close() { this.closed = true; F.closedWorkers++; }
  }

  class FakeQueueEvents { constructor() {} close() {} }

  require.cache[require.resolve('ioredis')] = { id: 'ioredis', filename: require.resolve('ioredis'), loaded: true, exports: FakeRedis };
  require.cache[require.resolve('bullmq')] = { id: 'bullmq', filename: require.resolve('bullmq'), loaded: true, exports: { Queue: FakeQueue, Worker: FakeWorker, QueueEvents: FakeQueueEvents } };
  return F;
}
module.exports = { installFakes };
