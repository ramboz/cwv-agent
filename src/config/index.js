import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Deep merge two objects
 * @param {Object} target - Target object
 * @param {Object} source - Source object
 * @returns {Object} Merged object
 */
function mergeDeep(target, source) {
  const output = { ...target };

  if (isObject(target) && isObject(source)) {
    Object.keys(source).forEach(key => {
      if (isObject(source[key])) {
        if (!(key in target)) {
          Object.assign(output, { [key]: source[key] });
        } else {
          output[key] = mergeDeep(target[key], source[key]);
        }
      } else {
        Object.assign(output, { [key]: source[key] });
      }
    });
  }

  return output;
}

function isObject(item) {
  return item && typeof item === 'object' && !Array.isArray(item);
}

/**
 * Load configuration for current environment
 * @param {string} env - Environment name (development, production, test)
 * @returns {Object} Configuration object
 */
export function loadConfig(env = null) {
  const environment = env || process.env.NODE_ENV || 'development';

  // Load default config
  const defaultConfigPath = join(__dirname, '../../config/default.json');
  const defaultConfig = JSON.parse(readFileSync(defaultConfigPath, 'utf-8'));

  // Try to load environment-specific config
  let envConfig = {};
  try {
    const envConfigPath = join(__dirname, `../../config/${environment}.json`);
    envConfig = JSON.parse(readFileSync(envConfigPath, 'utf-8'));
  } catch (error) {
    // Environment config doesn't exist, use defaults only
    console.log(`No config file found for environment '${environment}', using defaults`);
  }

  // Merge configs
  const finalConfig = mergeDeep(defaultConfig, envConfig);

  // Apply environment variable overrides
  applyEnvOverrides(finalConfig);

  return finalConfig;
}

/**
 * Apply environment variable overrides to config
 * @param {Object} config - Configuration object to modify
 */
function applyEnvOverrides(config) {
  // Model overrides
  if (process.env.CWV_MODEL_PRIMARY) {
    config.models.primary = process.env.CWV_MODEL_PRIMARY;
  }
  if (process.env.CWV_MODEL_FALLBACK) {
    config.models.fallback = process.env.CWV_MODEL_FALLBACK;
  }

  // Validation overrides
  if (process.env.CWV_VALIDATION_BLOCKING !== undefined) {
    config.validation.blockingMode = process.env.CWV_VALIDATION_BLOCKING === 'true';
  }
  if (process.env.CWV_VALIDATION_STRICT !== undefined) {
    config.validation.strictMode = process.env.CWV_VALIDATION_STRICT === 'true';
  }

  // Workflow overrides
  if (process.env.CWV_MAX_ITERATIONS) {
    config.workflow.maxIterations = parseInt(process.env.CWV_MAX_ITERATIONS, 10);
  }
  if (process.env.CWV_ENABLE_FEEDBACK_LOOP !== undefined) {
    config.workflow.enableFeedbackLoop = process.env.CWV_ENABLE_FEEDBACK_LOOP === 'true';
  }

  // Cache overrides
  if (process.env.CWV_CACHE_TTL) {
    config.cache.ttl = parseInt(process.env.CWV_CACHE_TTL, 10);
  }
}

/**
 * Get configuration value by dot-notation path
 * @param {Object} config - Configuration object
 * @param {string} path - Dot-notation path (e.g., 'models.primary')
 * @param {*} defaultValue - Default value if path not found
 * @returns {*} Configuration value
 */
export function getConfigValue(config, path, defaultValue = null) {
  const keys = path.split('.');
  let value = config;

  for (const key of keys) {
    if (value && typeof value === 'object' && key in value) {
      value = value[key];
    } else {
      return defaultValue;
    }
  }

  return value;
}

/**
 * Validate configuration
 * @param {Object} config - Configuration to validate
 * @returns {Object} Validation result { valid: boolean, errors: string[] }
 */
export function validateConfig(config) {
  const errors = [];

  // Required fields
  if (!config.models?.primary) {
    errors.push('Missing required config: models.primary');
  }
  if (!config.thresholds?.mobile) {
    errors.push('Missing required config: thresholds.mobile');
  }
  if (!config.thresholds?.desktop) {
    errors.push('Missing required config: thresholds.desktop');
  }

  // Validation rules
  if (config.validation?.minConfidence?.overall < 0 || config.validation?.minConfidence?.overall > 1) {
    errors.push('validation.minConfidence.overall must be between 0 and 1');
  }

  // Workflow settings
  if (config.workflow?.maxIterations < 1 || config.workflow?.maxIterations > 10) {
    errors.push('workflow.maxIterations must be between 1 and 10');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// Singleton config instance
let configInstance = null;

/**
 * Get configuration singleton
 * @param {boolean} reload - Force reload configuration
 * @returns {Object} Configuration object
 */
export function getConfig(reload = false) {
  if (!configInstance || reload) {
    configInstance = loadConfig();

    const validation = validateConfig(configInstance);
    if (!validation.valid) {
      console.warn('Configuration validation warnings:', validation.errors);
    }
  }

  return configInstance;
}

// Export default instance
export default getConfig();
