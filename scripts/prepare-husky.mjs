// Git hooks are a local-development concern. Vercel/CI installs may omit
// devDependencies, so never require Husky during CI or production installs.
if (process.env.CI || process.env.NODE_ENV === "production") {
  process.exit(0);
}

const { default: husky } = await import("husky");
husky();
