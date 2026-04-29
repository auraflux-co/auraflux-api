/**
 * Gemini API Client
 *
 * Handles all Gemini AI requests with:
 * - File upload management
 * - Automatic retry logic
 * - Rate limiting
 * - File cleanup
 */

const axios = require('axios');
const fs = require('fs');
const { logError, withRetry } = require('../error_logger');

class GeminiClient {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://generativelanguage.googleapis.com';
    this.model = options.model || 'gemini-2.5-flash';
    this.defaultTimeout = options.timeout || 60000;
    this.maxRetries = options.maxRetries || 3;
    this.maxFileSize = options.maxFileSize || 34 * 1024 * 1024; // 34MB

    // Track uploaded files for cleanup
    this.uploadedFiles = new Set();
  }

  /**
   * Generate content from text prompt
   * @param {string} prompt
   * @param {Object} options
   * @returns {Promise<string>}
   */
  async generateContent(prompt, options = {}) {
    const { maxOutputTokens = 1000, temperature = 0.3, systemInstruction = null } = options;

    const requestBody = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens, temperature },
    };

    if (systemInstruction) {
      requestBody.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    try {
      const result = await withRetry(
        async () => {
          const response = await axios.post(
            `${this.baseUrl}/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
            requestBody,
            {
              headers: { 'Content-Type': 'application/json' },
              timeout: this.defaultTimeout,
            }
          );
          return response.data;
        },
        {
          label: 'GEMINI_GENERATE',
          retries: this.maxRetries,
          baseMs: 2000,
        }
      );

      const text = (result.candidates?.[0]?.content?.parts || [])
        .map((p) => p.text || '')
        .join('')
        .trim();

      return text;
    } catch (err) {
      logError('GEMINI_GENERATE', err, { promptLength: prompt.length });
      throw err;
    }
  }

  /**
   * Multi-turn chat with optional systemInstruction.
   * Returns the full response object (not just text) so callers can inspect candidates.
   *
   * @param {Array<{role: string, parts: Array<{text: string}>}>} contents
   * @param {object} [opts]
   * @param {string}  [opts.systemInstruction]
   * @param {object}  [opts.generationConfig]
   * @returns {Promise<object>}  raw Gemini response
   */
  async chat(contents, opts = {}) {
    const { systemInstruction, generationConfig = {} } = opts;

    const requestBody = {
      contents,
      generationConfig: {
        maxOutputTokens: generationConfig.maxOutputTokens ?? 2048,
        temperature:     generationConfig.temperature     ?? 0.4,
        ...generationConfig,
      },
    };

    if (systemInstruction) {
      requestBody.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    try {
      const result = await withRetry(
        async () => {
          const response = await axios.post(
            `${this.baseUrl}/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
            requestBody,
            {
              headers: { 'Content-Type': 'application/json' },
              timeout: this.defaultTimeout,
            }
          );
          return response.data;
        },
        { label: 'GEMINI_CHAT', retries: this.maxRetries, baseMs: 2000 }
      );
      return result;
    } catch (err) {
      logError('GEMINI_CHAT', err, { messageCount: contents.length });
      throw err;
    }
  }

  /**
   * Upload file to Gemini Files API
   * @param {string} filePath
   * @returns {Promise<Object>} { name, uri, state }
   */
  async uploadFile(filePath) {
    const fileBuffer = fs.readFileSync(filePath);
    const fileSize = fileBuffer.length;

    if (fileSize > this.maxFileSize) {
      throw new Error(
        `File size ${(fileSize / 1024 / 1024).toFixed(1)}MB exceeds ${this.maxFileSize / 1024 / 1024}MB limit`
      );
    }

    const boundary = 'gemini_boundary_' + Date.now();
    const metadata = JSON.stringify({
      file: { display_name: require('path').basename(filePath) },
    });

    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
      Buffer.from(metadata),
      Buffer.from(`\r\n--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`),
      fileBuffer,
      Buffer.from(`\r\n--${boundary}--`),
    ]);

    try {
      const result = await withRetry(
        async () => {
          const response = await axios.post(
            `${this.baseUrl}/upload/v1beta/files?uploadType=multipart&key=${this.apiKey}`,
            body,
            {
              headers: {
                'Content-Type': `multipart/related; boundary=${boundary}`,
                'Content-Length': body.length,
              },
              timeout: 120000,
            }
          );
          return response.data;
        },
        {
          label: 'GEMINI_UPLOAD',
          retries: this.maxRetries,
          baseMs: 2000,
        }
      );

      const file = result.file;
      this.uploadedFiles.add(file.name);
      console.log(
        `[GeminiClient] Uploaded file: ${file.name} (${(fileSize / 1024 / 1024).toFixed(1)}MB)`
      );

      return file;
    } catch (err) {
      logError('GEMINI_UPLOAD', err, { filePath, fileSize });
      throw err;
    }
  }

  /**
   * Wait for uploaded file to be ready
   * @param {Object} file - File object from uploadFile()
   * @param {number} maxWaitMs - Maximum wait time
   * @returns {Promise<Object>}
   */
  async waitForFile(file, maxWaitMs = 30000) {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      if (file.state === 'ACTIVE') {
        return file;
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));

      const response = await axios.get(`${this.baseUrl}/v1beta/${file.name}?key=${this.apiKey}`, {
        timeout: 10000,
      });

      file = response.data;
    }

    throw new Error('Gemini file stuck in PROCESSING state');
  }

  /**
   * Analyze video with Gemini
   * @param {string} videoPath - Path to video file
   * @param {string} prompt - Analysis prompt
   * @param {Object} options
   * @returns {Promise<string>}
   */
  async analyzeVideo(videoPath, prompt, options = {}) {
    const file = await this.uploadFile(videoPath);
    const activeFile = await this.waitForFile(file);

    const requestBody = {
      contents: [
        {
          parts: [
            { text: prompt },
            { file_data: { mime_type: 'video/mp4', file_uri: activeFile.uri } },
          ],
        },
      ],
      generationConfig: {
        maxOutputTokens: options.maxOutputTokens || 500,
        temperature: options.temperature || 0.2,
      },
    };

    try {
      const response = await axios.post(
        `${this.baseUrl}/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
        requestBody,
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: this.defaultTimeout,
        }
      );

      const text = (response.data.candidates?.[0]?.content?.parts || [])
        .map((p) => p.text || '')
        .join('')
        .trim();

      // Clean up file after analysis
      await this.deleteFile(activeFile.name);

      return text;
    } catch (err) {
      logError('GEMINI_ANALYZE_VIDEO', err, { videoPath });
      throw err;
    }
  }

  /**
   * Delete uploaded file
   * @param {string} fileName - File name from upload response
   */
  async deleteFile(fileName) {
    try {
      await axios.delete(`${this.baseUrl}/v1beta/${fileName}?key=${this.apiKey}`, {
        timeout: 10000,
      });
      this.uploadedFiles.delete(fileName);
      console.log(`[GeminiClient] Deleted file: ${fileName}`);
    } catch (err) {
      logError('GEMINI_DELETE_FILE', err, { fileName });
    }
  }

  /**
   * Clean up all uploaded files
   */
  async cleanup() {
    const files = Array.from(this.uploadedFiles);
    console.log(`[GeminiClient] Cleaning up ${files.length} uploaded files`);

    await Promise.all(files.map((fileName) => this.deleteFile(fileName)));
  }
}

module.exports = GeminiClient;
