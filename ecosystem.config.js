module.exports = {
  apps: [
    {
      name: "cerebro-inteligente",
      cwd: __dirname,
      script: "npx",
      args: "ts-node src/server.ts",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      watch: false,
      restart_delay: 3000,
      time: true,
      env_production: {
        NODE_ENV: "production",
        APP_ENV: "production",
        ENV_FILE: ".env.prod",
      },
    },
  ],
};
