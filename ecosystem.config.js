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
      // APP_ENV y BRAIN_DRY_RUN se leen del .env (dotenv override). No forzar APP_ENV aquí.
      env_production: {
        ENV_FILE: ".env",
      },
    },
  ],
};
