import dotenv from 'dotenv';
dotenv.config();

/**
 * Sends a detailed Slack notification for scraping results
 * @param {Object} result - Scraping result object from scrapeVtexMerchant
 * @param {Object} options - Additional options (scraperName, isMaster, mode, executionTime)
 */
export async function sendScrapingNotification(result, options = {}) {
  if (!process.env.SLACK_WEBHOOK_URL) {
    console.log('ℹ️  Slack webhook not configured, skipping notification');
    return;
  }

  try {
    const blocks = buildScrapingMessage(result, options);
    const color = getMessageColor(result);
    await sendToSlack(blocks, color);
  } catch (error) {
    console.warn('⚠️  Error building Slack notification:', error.message);
  }
}

/**
 * Builds Slack Block Kit message from scraping result
 */
function buildScrapingMessage(result, options) {
  const { scraperName, isMaster, mode, executionTime } = options;
  const statusEmoji = result.success ? '✅' : '❌';
  const label = isMaster ? `${scraperName} (MAESTRO)` : scraperName;

  // Header
  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `🛒 ${label} - Scraping ${result.success ? 'Complete' : 'Failed'} ${statusEmoji}`
      }
    },

    // Timestamp
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `_${new Date().toLocaleString('es-AR', {
          timeZone: 'America/Argentina/Buenos_Aires',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        })}_`
      }]
    },

    { type: 'divider' }
  ];

  // Metrics (only if success)
  if (result.success) {
    const executionTimeStr = formatExecutionTime(executionTime);
    const successRate = calculateSuccessRate(result);

    const metricsText = [
      '*📊 Summary*',
      `• Total Products: ${result.totalProducts?.toLocaleString() || 0}`,
      `• Saved: ${result.savedProducts?.toLocaleString() || 0}`,
      `• Skipped: ${result.skippedProducts?.toLocaleString() || 0}`,
      `• Execution Time: ${executionTimeStr}`,
      `• Mode: ${mode?.toUpperCase() || 'UNKNOWN'}`
    ].join('\n');

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: metricsText
      }
    });

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*📈 Success Rate: ${successRate}%*`
      }
    });

    // Category stats (if available)
    const categoryStats = formatCategoryStats(result);
    if (categoryStats) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*📦 Category Performance* (Top 10)\n${categoryStats}`
        }
      });
    }
  }

  // Error section
  if (!result.success && result.error) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*⚠️ Error Details*\n\`\`\`${result.error}\`\`\``
      }
    });
  }

  return blocks;
}

/**
 * Determines message color based on result
 */
function getMessageColor(result) {
  if (!result.success) return '#ff0000'; // Red
  if (result.savedProducts === 0) return '#ffcc00'; // Yellow
  return '#36a64f'; // Green
}

/**
 * Calculates success rate percentage
 */
function calculateSuccessRate(result) {
  if (!result.totalProducts || result.totalProducts === 0) return '0.0';
  const rate = (result.savedProducts / result.totalProducts) * 100;
  return rate.toFixed(1);
}

/**
 * Formats execution time from milliseconds to human-readable string
 */
function formatExecutionTime(milliseconds) {
  if (!milliseconds || milliseconds === 0) return '0s';

  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${seconds}s`;
}

/**
 * Formats category statistics from product list
 */
function formatCategoryStats(result) {
  if (!result.products || result.products.length === 0) return null;

  const categoryCount = new Map();

  // Count products per category (use first/primary category)
  for (const product of result.products) {
    const primaryCategory = product.categories?.[0];
    if (primaryCategory) {
      categoryCount.set(
        primaryCategory,
        (categoryCount.get(primaryCategory) || 0) + 1
      );
    }
  }

  // If no categories found, return null
  if (categoryCount.size === 0) return null;

  // Sort by count descending and take top 10
  const sorted = Array.from(categoryCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  // Format as numbered list
  return sorted
    .map(([category, count], idx) => `${idx + 1}. ${category} - ${count} products`)
    .join('\n');
}

/**
 * Sends message to Slack webhook with error handling and timeout
 */
async function sendToSlack(blocks, color) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

  try {
    const response = await fetch(process.env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attachments: [{
          color: color,
          blocks: blocks
        }]
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Slack API responded with status ${response.status}`);
    }

    console.log('✅ Slack notification sent successfully');
  } catch (error) {
    if (error.name === 'AbortError') {
      console.warn('⚠️  Slack notification timed out after 10 seconds');
    } else {
      console.warn('⚠️  Failed to send Slack notification:', error.message);
    }
  }
}
