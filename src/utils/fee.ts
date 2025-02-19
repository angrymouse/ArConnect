import { Alarms } from "webextension-polyfill-ts";
import { fetchContract } from "verto-cache-interface";
import { getActiveKeyfile, getArweaveConfig, getStoreData } from "./background";
import { gql } from "./gateways";
import Arweave from "arweave";
import manifest from "../../public/manifest.json";
import redstone from "redstone-api";
import axios from "axios";

/**
 * Handle fee tx creation event using alarms
 */
export default async function handleFeeAlarm(alarmInfo: Alarms.Alarm) {
  if (!alarmInfo.name.includes("scheduled-fee-")) return;

  // client and tx info
  const linkedTransaction = alarmInfo.name.replace("scheduled-fee-", "");
  const arweave = new Arweave(await getArweaveConfig());

  // fee multiplier
  const storeData = await getStoreData();
  const feeMultiplier = storeData?.["settings"]?.feeMultiplier || 1;

  // get keyfile and address
  const userData = await getActiveKeyfile();

  // attempt to create fee
  try {
    const feeTarget = await selectVRTHolder();

    if (feeTarget) {
      const feeTx = await arweave.createTransaction(
        {
          target: feeTarget,
          quantity: await getFeeAmount(userData.address, arweave),
          data: Math.random().toString().slice(-4)
        },
        userData.keyfile
      );

      feeTx.addTag("App-Name", "ArConnect");
      feeTx.addTag("App-Version", manifest.version);
      feeTx.addTag("Type", "Fee-Transaction");
      feeTx.addTag("Linked-Transaction", linkedTransaction);

      // fee multiplication
      if (feeMultiplier > 1) {
        feeTx.reward = (+feeTx.reward * feeMultiplier).toFixed(0);
      }

      await arweave.transactions.sign(feeTx, userData.keyfile);

      const uploader = await arweave.transactions.getUploader(feeTx);

      while (!uploader.isComplete) {
        await uploader.uploadChunk();
      }
    }
  } catch (e) {
    console.log(
      `Unable to create fee for transaction "${linkedTransaction}"`,
      e
    );
  }
}

/**
 * Select a random holder from the weighted list of VRT holders
 */
async function selectVRTHolder() {
  try {
    const res = await fetchContract(
      "usjm4PCxUd5mtaon7zc97-dt-3qf67yPyqgzLnLqk5A"
    );

    if (!res) return undefined;

    const balances = res.state.balances;
    const vault = res.state.vault;
    let totalTokens = 0;

    for (const addr of Object.keys(balances)) {
      totalTokens += balances[addr];
    }

    for (const addr of Object.keys(vault)) {
      if (!vault[addr].length) continue;

      const vaultBalance = vault[addr]
        // @ts-ignore
        .map((a) => a.balance)
        // @ts-ignore
        .reduce((a, b) => a + b, 0);
      totalTokens += vaultBalance;

      if (addr in balances) balances[addr] += vaultBalance;
      else balances[addr] = vaultBalance;
    }

    const weighted: { [addr: string]: number } = {};

    for (const addr of Object.keys(balances)) {
      weighted[addr] = balances[addr] / totalTokens;
    }

    let sum = 0;
    const r = Math.random();

    for (const addr of Object.keys(weighted)) {
      sum += weighted[addr];

      if (r <= sum && weighted[addr] > 0) {
        return addr;
      }
    }

    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Calculate the fee amount needed for a signing
 *
 * @param address The address to base off the calculation
 * @param arweave Arweave client
 *
 * @returns Fee amount in string
 */
export async function getFeeAmount(address: string, arweave: Arweave) {
  const res = await gql(
    `
      query($address: String!) {
        transactions(
          owners: [$address]
          tags: [
            { name: "App-Name", values: "ArConnect" }
            { name: "Type", values: "Fee-Transaction" }
          ]
          first: 11
        ) {
          edges {
            node {
              id
            }
          }
        }
      }
    `,
    { address }
  );

  let arPrice = 0;

  try {
    // grab price from redstone API
    const { value } = await redstone.getPrice("AR");

    arPrice = value;
  } catch {
    // fallback price API
    const { data: res }: any = await axios.get(
      "https://api.coingecko.com/api/v3/simple/price?ids=arweave&vs_currencies=usd"
    );
    arPrice = res.arweave.usd;
  }

  const usdPrice = 1 / arPrice; // 1 USD how much AR

  if (res.data.transactions.edges.length) {
    const usd = res.data.transactions.edges.length >= 10 ? 0.01 : 0.03;

    return arweave.ar.arToWinston((usdPrice * usd).toString());
  } else return arweave.ar.arToWinston((usdPrice * 0.01).toString());
}
