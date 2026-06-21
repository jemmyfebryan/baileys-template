module.exports = {
  apps: [{
    name: 'baileys-bot',
    script: './src/index.js',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
      PORT: 3100,
      WS_PORT: 3101,
      LOG_LEVEL: 'info'
    },
    env_development: {
      NODE_ENV: 'development',
      PORT: 3100,
      WS_PORT: 3101,
      LOG_LEVEL: 'debug'
    },
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
  }]
};
