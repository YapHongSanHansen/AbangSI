/**
 * One-off: fund the ReelForge seller + buyer from another preprod wallet whose
 * mnemonic lives in a KEY=VALUE file (approved by the user: 60 tADA seller,
 * 40 tADA buyer from the Bulkhead operator wallet). Never prints the mnemonic.
 *   tsx scripts/fund.ts <envFilePath> <VAR_NAME> <sellerAda> <buyerAda>
 */
import { readFileSync } from "node:fs";
import { Address, Assets, Client, preprod, TransactionHash } from "@evolution-sdk/evolution";
import { toMasumiSellerSigner } from "@x402/cardano";
import { blockfrost, required } from "../src/config.js";
import { explorerTx, NETWORK } from "../src/constants.js";

const [file, varName, sellerAda, buyerAda] = process.argv.slice(2);
const strip = (s: string) => s.split("").filter(c => c !== String.fromCharCode(34) && c !== String.fromCharCode(39)).join("").trim();
const line = readFileSync(file, "utf8").split(/\r?\n/).find(l => l.startsWith(`${varName}=`));
if (!line) throw new Error(`${varName} not found`);
const fromMnemonic = strip(line.slice(varName.length + 1));
const addrOf = (m: string) => toMasumiSellerSigner({ network: NETWORK, mnemonic: m }).sellerAddress;
const seller = addrOf(required("SELLER_MNEMONIC"));
const buyer = addrOf(required("BUYER_MNEMONIC"));
const lovelace = (ada: string) => BigInt(Math.round(Number(ada) * 1e6));

try {
  const client = Client.make(preprod).withBlockfrost(blockfrost).withSeed({ mnemonic: fromMnemonic });
  const from = await client.address();
  const built = await client.newTx()
    .payToAddress({ address: Address.fromBech32(seller), assets: Assets.fromLovelace(lovelace(sellerAda)) })
    .payToAddress({ address: Address.fromBech32(buyer), assets: Assets.fromLovelace(lovelace(buyerAda)) })
    .build({ changeAddress: from });
  const hash = await (await built.sign()).submit();
  const hex = TransactionHash.toHex(hash);
  console.log(`submitted ${hex}\n  ${explorerTx(hex)}`);
  await client.awaitTx(hash, 5_000, 300_000);
  console.log(`confirmed: ${sellerAda} tADA -> seller, ${buyerAda} tADA -> buyer`);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error("funding failed:", msg.split(" ").filter(w => !fromMnemonic.includes(w) || w.length < 3).join(" ").slice(0, 600));
  process.exit(1);
}