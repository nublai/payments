import { defineConfig } from "@wagmi/cli";
import { foundry } from "@wagmi/cli/plugins";

export default defineConfig({
  out: "deployments/abis/index.ts",
  plugins: [
    foundry({
      project: ".",
      include: [
        "Orchestrator.sol/Orchestrator.json",
        "TownsAccount.sol/TownsAccount.json",
        "Simulator.sol/Simulator.json",
        "SimpleFunder.sol/SimpleFunder.json",
        "SimpleSettler.sol/SimpleSettler.json",
        "Escrow.sol/Escrow.json",
        "MultiSigSigner.sol/MultiSigSigner.json",
      ],
    }),
  ],
});
