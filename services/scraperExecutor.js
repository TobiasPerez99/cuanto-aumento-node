/**
 * Scraper Executor Service
 * Executes scrapers asynchronously with webhook notifications
 */

import { SCRAPERS, runScraper } from '../scripts/populate-db.js';
import { updateJobStatus, getJob } from './jobManager.js';
import { sendWebhook } from './webhookService.js';

/**
 * Executes a scraper asynchronously
 * @param {string} jobId - Job ID
 * @param {string} scraperKey - Scraper key (e.g., 'disco')
 * @param {string} mode - Execution mode ('categories' | 'eans')
 */
export async function executeScraperAsync(jobId, scraperKey, mode = 'categories') {
  const scraper = SCRAPERS[scraperKey];

  if (!scraper) {
    const error = `Scraper not found: ${scraperKey}`;
    updateJobStatus(jobId, 'failed', { error });
    return;
  }

  try {
    // Update to running and send STARTED webhook
    updateJobStatus(jobId, 'running');
    const job = getJob(jobId);
    await sendWebhook('started', job);

    console.log(`🚀 Executing scraper: ${jobId} - ${scraper.name}`);

    // Execute scraper (reuse existing logic from populate-db.js)
    const result = await runScraper(scraperKey, scraper, mode);

    // Update job with result
    updateJobStatus(jobId, 'completed', { result });

    // Send COMPLETED webhook
    const updatedJob = getJob(jobId);
    await sendWebhook('completed', updatedJob);

    console.log(`✅ Scraper completed: ${jobId} - ${scraper.name}`);

  } catch (error) {
    console.error(`❌ Scraper failed: ${jobId} - ${error.message}`);

    // Update job with error
    updateJobStatus(jobId, 'failed', { error: error.message });

    // Send COMPLETED webhook with failure status
    const failedJob = getJob(jobId);
    await sendWebhook('completed', failedJob);
  }
}
