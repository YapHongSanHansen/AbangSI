/** Checks ReelForge's Masumi registry entry: on-chain NFT, metadata, holder, public status, availability. */
import { agentIdentifier, blockfrost, publicUrl, sellerWallet } from "../src/config.js";
import { ESCROW_ADDRESS, metadataText, paymentKeyHash } from "../src/constants.js";

const id = agentIdentifier();
if (!id) throw new Error("MASUMI_AGENT_IDENTIFIER not set — run pnpm register");
const bf = (p: string) => fetch(`${blockfrost.baseUrl}${p}`, { headers: { project_id: blockfrost.projectId } }).then(r => r.ok ? r.json() : null) as Promise<any>;
const ok = (label: string, pass: boolean, detail = "") => console.log(`${pass ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);

const asset = await bf(`/assets/${id}`);
ok("registry NFT exists", !!asset, asset?.initial_mint_tx_hash);
const md = asset?.onchain_metadata;
ok("api_base_url", metadataText(md?.api_base_url) === publicUrl(), metadataText(md?.api_base_url));
const src = md?.supported_payment_sources?.[0];
ok("payment source Cardano/Preprod/Web3CardanoV2", metadataText(src?.chain) === "Cardano" && metadataText(src?.network) === "Preprod" && metadataText(src?.settlement?.paymentSourceType) === "Web3CardanoV2");
ok("escrow address", metadataText(src?.settlement?.address) === ESCROW_ADDRESS);
ok("pricing Dynamic", src?.pricing?.pricingType === "Dynamic");
const holders = await bf(`/assets/${id}/addresses`) as Array<{ address: string }> | null;
ok("held by seller", !!holders?.some(h => paymentKeyHash(h.address) === paymentKeyHash(sellerWallet().address)));
const avail = await fetch(`${publicUrl()}/availability`).then(r => r.json() as Promise<any>).catch(() => null);
ok("public /availability", avail?.status === "available");
const reg = await fetch("https://registry.masumi.network/api/v1/registry-entry/", {
  method: "POST", headers: { token: "public-test-key-masumi-registry-c23f3d21", "Content-Type": "application/json" },
  body: JSON.stringify({ network: "Preprod", filter: { assetIdentifier: id, status: ["Online", "Offline", "Invalid", "Deregistered"] } }),
}).then(r => r.json()).catch(e => ({ error: String(e) })) as any;
const entry = reg?.data?.entries?.[0] ?? reg?.data?.RegistryEntries?.[0];
ok("Masumi registry service indexed", !!entry, entry ? `status=${entry.status}` : JSON.stringify(reg).slice(0, 200));