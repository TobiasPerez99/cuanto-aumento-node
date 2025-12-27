/**
 * Webhook Service
 * Sends HTTP POST notifications to configured webhook URL
 */

/**
 * Sends webhook notification
 * @param {string} event - Event type ('started' | 'completed')
 * @param {Object} jobData - Job data
 * @returns {Promise<Object>} { success: boolean, error?: string }
 */
export async function sendWebhook(event, jobData) {
  const webhookUrl = process.env.WEBHOOK_URL;

  if (!webhookUrl) {
    console.log('ℹ️  Webhook URL not configured, skipping notification');
    return { success: false, error: 'Not configured' };
  }

  const payload = buildWebhookPayload(event, jobData);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'CuantoAumento-Scraper/1.0'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Webhook responded with status ${response.status}`);
    }

    console.log(`✅ Webhook sent: ${event} for job ${jobData.jobId}`);
    return { success: true };

  } catch (error) {
    clearTimeout(timeoutId);
    const errorMsg = error.name === 'AbortError'
      ? 'Webhook timeout after 10 seconds'
      : error.message;

    console.warn(`⚠️  Webhook failed: ${errorMsg}`);
    return { success: false, error: errorMsg };
  }
}

/**
 * Builds webhook payload based on event type
 * @param {string} event - Event type
 * @param {Object} jobData - Job data
 * @returns {Object} Payload for webhook
 */
function buildWebhookPayload(event, jobData) {
  const base = {
    event,
    jobId: jobData.jobId,
    scraperName: jobData.scraperName,
    scraperKey: jobData.scraperKey,
    timestamp: new Date().toISOString(),
    status: jobData.status
  };

  if (event === 'completed') {
    const executionTime = calculateExecutionTime(jobData);

    if (jobData.status === 'completed' && jobData.result) {
      // Success case
      base.result = jobData.result;
      base.executionTime = executionTime;
    } else if (jobData.status === 'failed') {
      // Failure case
      base.error = jobData.error;
      base.executionTime = executionTime;
    }
  }

  return base;
}

/**
 * Calculates execution time from job timestamps
 * @param {Object} jobData - Job data with startTime and endTime
 * @returns {number} Execution time in milliseconds
 */
function calculateExecutionTime(jobData) {
  if (!jobData.startTime || !jobData.endTime) return 0;
  const start = new Date(jobData.startTime).getTime();
  const end = new Date(jobData.endTime).getTime();
  return end - start;
}
