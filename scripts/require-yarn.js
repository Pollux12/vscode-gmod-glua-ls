const userAgent = process.env.npm_config_user_agent || "";

if (!userAgent.includes("yarn/")) {
    console.error("This repository uses Yarn. Run `yarn install --frozen-lockfile` instead of `npm install`.");
    process.exit(1);
}
