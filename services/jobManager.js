/**
 * Job Manager Service
 * Manages scraper job lifecycle in-memory
 */

import { v4 as uuidv4 } from 'uuid';

// In-memory job storage
const jobs = new Map();

/**
 * Creates a new job and returns its ID
 * @param {string} scraperKey - Internal scraper key (e.g., 'disco')
 * @param {string} scraperName - Display name (e.g., 'Disco')
 * @returns {string} jobId - UUID v4
 */
export function createJob(scraperKey, scraperName) {
  const jobId = uuidv4();
  const job = {
    jobId,
    scraperKey,
    scraperName,
    status: 'pending',
    startTime: null,
    endTime: null,
    result: null,
    error: null,
    createdAt: new Date().toISOString()
  };

  jobs.set(jobId, job);
  console.log(`📝 Job created: ${jobId} for ${scraperName}`);
  return jobId;
}

/**
 * Retrieves a job by its ID
 * @param {string} jobId - Job ID
 * @returns {Object|null} Job data or null if not found
 */
export function getJob(jobId) {
  return jobs.get(jobId) || null;
}

/**
 * Updates job status and additional data
 * @param {string} jobId - Job ID
 * @param {string} status - New status ('pending', 'running', 'completed', 'failed')
 * @param {Object} additionalData - Additional data to merge into job
 */
export function updateJobStatus(jobId, status, additionalData = {}) {
  const job = jobs.get(jobId);
  if (!job) {
    throw new Error(`Job not found: ${jobId}`);
  }

  job.status = status;

  // Set timestamps based on status
  if (status === 'running') {
    job.startTime = new Date().toISOString();
  } else if (status === 'completed' || status === 'failed') {
    job.endTime = new Date().toISOString();
  }

  // Merge additional data
  Object.assign(job, additionalData);
  jobs.set(jobId, job);

  console.log(`📊 Job ${jobId} updated to status: ${status}`);
}

/**
 * Checks if a scraper is currently running
 * @param {string} scraperKey - Scraper key to check
 * @returns {boolean} True if scraper is running
 */
export function isScraperRunning(scraperKey) {
  for (const job of jobs.values()) {
    if (job.scraperKey === scraperKey && job.status === 'running') {
      return true;
    }
  }
  return false;
}

/**
 * Retrieves all jobs with optional filtering
 * @param {Object} filters - Filter options
 * @param {string} filters.status - Filter by status
 * @param {string} filters.scraperKey - Filter by scraper
 * @param {number} filters.limit - Max results (default 50, max 200)
 * @param {number} filters.offset - Offset for pagination
 * @returns {Object} { jobs, total, offset, limit }
 */
export function getAllJobs(filters = {}) {
  let filtered = Array.from(jobs.values());

  // Apply filters
  if (filters.status) {
    filtered = filtered.filter(j => j.status === filters.status);
  }

  if (filters.scraperKey) {
    filtered = filtered.filter(j => j.scraperKey === filters.scraperKey);
  }

  // Sort by createdAt descending (newest first)
  filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  // Apply pagination
  const offset = filters.offset || 0;
  const limit = Math.min(filters.limit || 50, 200);

  return {
    jobs: filtered.slice(offset, offset + limit),
    total: filtered.length,
    offset,
    limit
  };
}

/**
 * Removes old completed/failed jobs from memory
 * @param {number} maxAgeHours - Maximum age in hours (default 24)
 * @returns {number} Number of jobs deleted
 */
export function cleanupOldJobs(maxAgeHours = 24) {
  const cutoff = Date.now() - (maxAgeHours * 60 * 60 * 1000);
  let deleted = 0;

  for (const [jobId, job] of jobs.entries()) {
    // Never delete running or pending jobs
    if (job.status === 'running' || job.status === 'pending') {
      continue;
    }

    const jobTime = new Date(job.createdAt).getTime();
    if (jobTime < cutoff) {
      jobs.delete(jobId);
      deleted++;
    }
  }

  if (deleted > 0) {
    console.log(`🧹 Cleanup: Removed ${deleted} old jobs`);
  }
  return deleted;
}

/**
 * Gets count of jobs by status
 * @returns {Object} Count by status
 */
export function getJobStats() {
  const stats = {
    total: jobs.size,
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0
  };

  for (const job of jobs.values()) {
    if (stats[job.status] !== undefined) {
      stats[job.status]++;
    }
  }

  return stats;
}

// Auto-cleanup on module initialization
cleanupOldJobs();
