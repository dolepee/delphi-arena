import "dotenv/config";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assessmentsFileSchema, policySchema } from "./model.js";

export const EXPECTED_WALLET = "0x86bE235Bb9Aa6D9E2Cf89b2f4E9c90e1ecb7C781";

export function stateDirectory(): string {
  return resolve(process.env.DELPHI_STATE_DIR?.trim() || "state");
}

export async function loadPolicy() {
  const path = resolve(process.env.DELPHI_POLICY_PATH?.trim() || "config/policy.json");
  return policySchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export async function loadAssessments() {
  const path = resolve(
    process.env.DELPHI_ASSESSMENTS_PATH?.trim() || "config/assessments.json",
  );
  return assessmentsFileSchema.parse(JSON.parse(await readFile(path, "utf8"))).assessments;
}

export function liveConfirmation(): string {
  return `DELPHI-LIVE:Conviction:${EXPECTED_WALLET}`;
}

export function assertEnvironment(): void {
  if (process.env.DELPHI_NETWORK !== "competition-testnet") {
    throw new Error("DELPHI_NETWORK must be competition-testnet");
  }
  if (process.env.DELPHI_SIGNER_TYPE !== "private_key") {
    throw new Error("DELPHI_SIGNER_TYPE must be private_key");
  }
  if (!process.env.WALLET_PRIVATE_KEY?.trim()) throw new Error("wallet signer is missing");
  if (!process.env.DELPHI_API_ACCESS_KEY?.trim()) throw new Error("Delphi API key is missing");
  const configured = process.env.DELPHI_EXPECTED_WALLET?.trim() || EXPECTED_WALLET;
  if (configured.toLowerCase() !== EXPECTED_WALLET.toLowerCase()) {
    throw new Error("configured wallet does not match the registered competition wallet");
  }
}
