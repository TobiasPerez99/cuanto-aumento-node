/**
 * Scraper Execution Routes
 * Authenticated endpoints for executing scrapers asynchronously
 */

import { Router } from 'express';
import { authMiddleware } from '../middlewares/authMiddleware.js';
import { SCRAPERS } from '../scripts/populate-db.js';
import {
  createJob,
  getJob,
  isScraperRunning,
  getAllJobs,
  cleanupOldJobs,
  getJobStats
} from '../services/jobManager.js';
import { executeScraperAsync } from '../services/scraperExecutor.js';

const router = Router();

// Valid scraper names for validation
const VALID_SCRAPERS = Object.keys(SCRAPERS);

/**
 * POST /api/scrape/:scraperName
 * Execute a specific scraper
 */
router.post('/scrape/:scraperName', authMiddleware, async (req, res) => {
  try {
    const scraperKey = req.params.scraperName.toLowerCase();
    const mode = req.body?.mode || 'categories';

    // Validate scraper exists
    if (!VALID_SCRAPERS.includes(scraperKey)) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: `Scraper "${scraperKey}" not found`,
        availableScrapers: VALID_SCRAPERS
      });
    }

    const scraper = SCRAPERS[scraperKey];

    // Validate mode (only for non-bank scrapers)
    if (scraper.type !== 'bank') {
      const validModes = ['categories', 'eans'];
      if (!validModes.includes(mode)) {
        return res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: `Invalid mode "${mode}". Valid options: ${validModes.join(', ')}`
        });
      }
    }

    // Check if scraper is already running
    if (isScraperRunning(scraperKey)) {
      return res.status(409).json({
        success: false,
        error: 'Conflict',
        message: `Scraper "${scraperKey}" is already running`
      });
    }

    // Create job
    const jobId = createJob(scraperKey, scraper.name);

    // Start async execution (fire-and-forget)
    setImmediate(async () => {
      await executeScraperAsync(jobId, scraperKey, mode);
    });

    // Return immediately with job ID
    res.status(202).json({
      success: true,
      jobId,
      scraperName: scraper.name,
      status: 'pending',
      message: 'Scraper execution started',
      statusUrl: `/api/scrape/status/${jobId}`
    });

  } catch (error) {
    console.error('Error starting scraper:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Error',
      message: error.message
    });
  }
});

/**
 * POST /api/scrape/all
 * Execute all scrapers
 */
router.post('/scrape/all', authMiddleware, async (req, res) => {
  try {
    const mode = req.body?.mode || 'categories';
    const jobs = [];
    const alreadyRunning = [];

    // Check which scrapers are already running
    for (const [key, scraper] of Object.entries(SCRAPERS)) {
      if (isScraperRunning(key)) {
        alreadyRunning.push(scraper.name);
      }
    }

    if (alreadyRunning.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'Conflict',
        message: 'Some scrapers are already running',
        alreadyRunning
      });
    }

    // Create jobs for all scrapers
    for (const [key, scraper] of Object.entries(SCRAPERS)) {
      const jobId = createJob(key, scraper.name);
      jobs.push({
        jobId,
        scraperName: scraper.name,
        scraperKey: key,
        status: 'pending'
      });

      // Start async execution (fire-and-forget)
      setImmediate(async () => {
        await executeScraperAsync(jobId, key, mode);
      });
    }

    res.status(202).json({
      success: true,
      jobs,
      message: 'All scrapers queued for execution',
      totalJobs: jobs.length
    });

  } catch (error) {
    console.error('Error starting all scrapers:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Error',
      message: error.message
    });
  }
});

/**
 * GET /api/scrape/status/:jobId
 * Get job status and results
 */
router.get('/scrape/status/:jobId', authMiddleware, async (req, res) => {
  try {
    const job = getJob(req.params.jobId);

    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: 'Job not found'
      });
    }

    res.json(job);

  } catch (error) {
    console.error('Error getting job status:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Error',
      message: error.message
    });
  }
});

/**
 * GET /api/scrape/jobs
 * List all jobs with filtering and pagination
 */
router.get('/scrape/jobs', authMiddleware, async (req, res) => {
  try {
    const filters = {
      status: req.query.status,
      scraperKey: req.query.scraperKey,
      limit: parseInt(req.query.limit) || 50,
      offset: parseInt(req.query.offset) || 0
    };

    const result = getAllJobs(filters);
    res.json(result);

  } catch (error) {
    console.error('Error listing jobs:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Error',
      message: error.message
    });
  }
});

/**
 * GET /api/scrape/running
 * Get currently running scrapers
 */
router.get('/scrape/running', authMiddleware, async (req, res) => {
  try {
    const result = getAllJobs({ status: 'running' });
    res.json({
      running: result.jobs,
      count: result.total
    });
  } catch (error) {
    console.error('Error getting running scrapers:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Error',
      message: error.message
    });
  }
});

/**
 * GET /api/scrape/stats
 * Get job statistics
 */
router.get('/scrape/stats', authMiddleware, async (req, res) => {
  try {
    const stats = getJobStats();
    res.json(stats);
  } catch (error) {
    console.error('Error getting stats:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Error',
      message: error.message
    });
  }
});

/**
 * POST /api/scrape/cleanup
 * Cleanup old jobs
 */
router.post('/scrape/cleanup', authMiddleware, async (req, res) => {
  try {
    const maxAgeHours = req.body?.maxAgeHours || 24;
    const deletedCount = cleanupOldJobs(maxAgeHours);

    res.json({
      success: true,
      deletedCount,
      message: 'Cleanup completed'
    });

  } catch (error) {
    console.error('Error cleaning up jobs:', error);
    res.status(500).json({
      success: false,
      error: 'Internal Error',
      message: error.message
    });
  }
});

export default router;
