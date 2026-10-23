'use strict';
/**
 * OmniSMS — Processus worker SMS séparé (recommandé à l'échelle).
 *
 *   npm run worker
 *
 * Démare UNIQUEMENT les workers BullMQ (sms ; transcription déjà séparé via
 * son propre entry si besoin), sans le serveur HTTP. Config :
 *   SMS_WORKER_CONCURRENCY (défaut 2), SMS_WORKER_MAX_PER_MIN (défaut illimité),
 *   WORKER_IN_WEB_PROCESS=false à mettre sur le service web Render.
 * Sans Redis → mode inline dégénéré (les jobs s'exécuteraient dans CE process
 * uniquement s'ils y sont ajoutés) : en pratique, REDIS_URL est requis pour
 * un vrai worker séparé.
 */
const { logger } = require('../middleware/logger');
const { startSmsWorker } = require('../services/smsQueueWorker');
const { getQueueStatus, shutdownQueues } = require('../services/queueService');

startSmsWorker();
setInterval(() => {
  try { logger.info('[SmsWorker] heartbeat', getQueueStatus()); } catch (_) {}
}, 60000).unref();

process.on('unhandledRejection', (reason) => {
  logger.error('[SmsWorker] Unhandled promise rejection (log limité 1/min)', { reason: String(reason).slice(0, 300) });
});
let _closing = false;
process.on('SIGTERM', async () => {
  if (_closing) return;
  _closing = true;
  logger.info('[SmsWorker] SIGTERM — arrêt propre des files.');
  try { await shutdownQueues(); } catch (_) {}
  process.exit(0);
});
process.on('SIGINT', () => process.exit(0));
