{ pkgs, piHost }:
let
  hostRoot = "${piHost}/lib/node_modules/pi-monorepo";
  manifest = pkgs.lib.importJSON ../ai/pi/extensions/package.json;
  lock = pkgs.lib.importJSON ../ai/pi/extensions/package-lock.json;
  typecheckPackage = manifest // {
    devDependencies = pkgs.lib.getAttrs [
      "@types/node"
      "typescript"
    ] manifest.devDependencies;
  };
  nodeModules = pkgs.importNpmLock.buildNodeModules {
    npmRoot = ../ai/pi/extensions;
    package = typecheckPackage;
    packageLock = lock // {
      packages = lock.packages // {
        "" = lock.packages."" // {
          inherit (typecheckPackage) devDependencies;
        };
      };
    };
    inherit (pkgs) nodejs;
    derivationArgs.npmInstallFlags = "--legacy-peer-deps";
  };
  typecheckConfig = pkgs.writeText "pi-host-tsconfig.json" (
    builtins.toJSON {
      extends = "./ai/pi/extensions/tsconfig.json";
      compilerOptions = {
        typeRoots = [ "./ai/pi/extensions/node_modules/@types" ];
        paths = {
          "@earendil-works/pi-coding-agent" = [ "${hostRoot}/dist/index.d.ts" ];
          "@earendil-works/pi-agent-core" = [
            "${hostRoot}/node_modules/@earendil-works/pi-agent-core/dist/index.d.ts"
          ];
          "@earendil-works/pi-ai" = [
            "${hostRoot}/node_modules/@earendil-works/pi-ai/dist/compat.d.ts"
          ];
          "@earendil-works/pi-ai/compat" = [
            "${hostRoot}/node_modules/@earendil-works/pi-ai/dist/compat.d.ts"
          ];
          "@earendil-works/pi-tui" = [
            "${hostRoot}/node_modules/@earendil-works/pi-tui/dist/index.d.ts"
          ];
          typebox = [ "${hostRoot}/node_modules/typebox/build/index.d.mts" ];
        };
      };
    }
  );
in
pkgs.runCommand "pi-extension-typecheck"
  {
    nativeBuildInputs = [ pkgs.nodejs ];
  }
  ''
    cp -r ${../ai} ai
    chmod -R u+w ai
    ln -s ${nodeModules}/node_modules ai/pi/extensions/node_modules
    cp ${typecheckConfig} pi-host-tsconfig.json
    node ai/pi/extensions/node_modules/typescript/bin/tsc \
      --noEmit --project pi-host-tsconfig.json
    touch $out
  ''
