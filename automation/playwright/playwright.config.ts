import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./workflows",
  timeout: 60_000,
  retries: 0,
  use: {
    headless: true,
    viewport: { width: 1280, height: 720 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  // Credentials must be provided via environment variables
  // GOOGLE_USERNAME, GOOGLE_PASSWORD for Google Business Profile
  // FACEBOOK_EMAIL, FACEBOOK_PASSWORD for Facebook Business
  // etc.
});
