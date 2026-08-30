import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadBrand } from "./common/load-brand.js";
import { loadMarket } from "./common/load-market.js";
import { loadPlatforms } from "./common/load-platforms.js";
import { buildStatus, buildSummary } from "./common/status-manager.js";
import { generateReport } from "./common/report-generator.js";

interface CliArgs {
  command: string;
  brand: string;
  market: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let command = "";
  let brand = "";
  let market = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--brand" && args[i + 1]) {
      brand = args[i + 1];
      i++;
    } else if (args[i] === "--market" && args[i + 1]) {
      market = args[i + 1];
      i++;
    } else if (!args[i].startsWith("--")) {
      command = args[i];
    }
  }

  return { command, brand, market };
}

function validateArgs(args: CliArgs): void {
  if (!args.command) {
    console.error("Usage: npm run ops -- <command> --brand <id> --market <code>");
    console.error("Commands: status, validate, report");
    process.exit(1);
  }
  if (!args.brand) {
    console.error("Missing --brand argument");
    process.exit(1);
  }
  if (!args.market) {
    console.error("Missing --market argument");
    process.exit(1);
  }
}

function runValidate(args: CliArgs): void {
  try {
    const brandProfile = loadBrand(args.brand);
    console.log(`✅ Brand loaded: ${brandProfile.name} (${brandProfile.id})`);

    const { target } = loadMarket(args.brand, args.market);
    console.log(`✅ Market ${args.market} enabled: ${target.enabled} (locale: ${target.locale})`);

    const platforms = loadPlatforms(args.market, "operational");
    console.log(`✅ Platforms loaded: ${platforms.length} total`);

    const { listings } = loadMarket(args.brand, args.market);
    console.log(`✅ Listings loaded: ${listings.length}`);

    const statuses = buildStatus(platforms, listings);
    const summary = buildSummary(statuses, brandProfile.name, args.market, target.locale, brandProfile);

    console.log("");
    console.log("✅ Validation passed");
    if (summary.dataQualityAlerts.length > 0) {
      console.log("");
      console.log("Data quality alerts:");
      for (const alert of summary.dataQualityAlerts) {
        console.log(`  ⚠ ${alert}`);
      }
    }
  } catch (err) {
    console.error(`❌ Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

function runStatus(args: CliArgs): void {
  try {
    const brandProfile = loadBrand(args.brand);
    const { target } = loadMarket(args.brand, args.market);
    const platforms = loadPlatforms(args.market, "operational");
    const { listings } = loadMarket(args.brand, args.market);
    const statuses = buildStatus(platforms, listings);
    const summary = buildSummary(statuses, brandProfile.name, args.market, target.locale, brandProfile);

    console.log(`Brand: ${summary.brand}`);
    console.log(`Market: ${summary.market}`);
    console.log(`Locale: ${summary.locale}`);
    console.log("");
    console.log(`Platforms: ${summary.totalPlatforms}`);
    console.log(`Verified: ${summary.verified}`);
    console.log(`Pending: ${summary.pending}`);
    console.log(`In progress: ${summary.inProgress}`);
    console.log(`Submitted: ${summary.submitted}`);
    console.log(`Verification required: ${summary.verificationRequired}`);
    console.log(`Rejected: ${summary.rejected}`);
    console.log(`Disabled: ${summary.disabled}`);

    if (summary.dataQualityAlerts.length > 0) {
      console.log("");
      console.log("Data quality:");
      for (const alert of summary.dataQualityAlerts) {
        console.log(`  ⚠ ${alert}`);
      }
    }
  } catch (err) {
    console.error(`❌ Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

function runReport(args: CliArgs): void {
  try {
    const brandProfile = loadBrand(args.brand);
    const { target } = loadMarket(args.brand, args.market);
    const platforms = loadPlatforms(args.market, "operational");
    const { listings } = loadMarket(args.brand, args.market);
    const statuses = buildStatus(platforms, listings);
    const summary = buildSummary(statuses, brandProfile.name, args.market, target.locale, brandProfile);

    const report = generateReport(summary, statuses, brandProfile);

    const reportDir = resolve(process.cwd(), "reports", args.brand, args.market);
    const reportPath = resolve(reportDir, "README.md");
    writeFileSync(reportPath, report, "utf-8");

    console.log(`✅ Report generated: ${reportPath}`);
  } catch (err) {
    console.error(`❌ Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

const args = parseArgs(process.argv);
validateArgs(args);

switch (args.command) {
  case "validate":
    runValidate(args);
    break;
  case "status":
    runStatus(args);
    break;
  case "report":
    runReport(args);
    break;
  default:
    console.error(`Unknown command: ${args.command}`);
    console.error("Commands: status, validate, report");
    process.exit(1);
}
