import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { replaceSuffix, isValidSolFile, outputResult } from './io';
import { compileSolFiles } from './solCompile';
import { handleTranspilationError, transform, transpile } from './transpiler';
import { analyseSol } from './utils/analyseSol';
import {
  compileCairo,
  runStarknetCallOrInvoke,
  runStarknetCompile,
  runStarknetDeclare,
  runStarknetDeploy,
  runStarknetDeployAccount,
  runStarknetStatus,
} from './starknetCli';
import chalk from 'chalk';
import { runVenvSetup } from './utils/setupVenv';
import { runTests } from './testing';

import { generateSolInterface } from './icf/interfaceCallForwarder';
import { postProcessCairoFile } from './utils/postCairoWrite';
import { defaultBasePathAndIncludePath } from './utils/utils';

export type CompilationOptions = {
  warnings?: boolean;
  includePaths?: string[];
  basePath?: string;
};

export type TranspilationOptions = {
  checkTrees?: boolean;
  dev: boolean;
  order?: string;
  printTrees?: boolean;
  strict?: boolean;
  warnings?: boolean;
  until?: string;
};

export type PrintOptions = {
  highlight?: string[];
  stubs?: boolean;
};

export type OutputOptions = {
  compileCairo?: boolean;
  compileErrors?: boolean;
  outputDir: string;
  formatCairo: boolean;
  result: boolean;
};

type CliOptions = CompilationOptions &
  TranspilationOptions &
  PrintOptions &
  OutputOptions &
  IOptionalDebugInfo;

const program = new Command();

program
  .command('transpile <files...>')
  .option('--compile-cairo')
  .option('--no-compile-errors')
  .option('--check-trees')
  // for development mode
  .option('--dev', 'Run AST sanity checks on every pass instead of the final AST only', false)
  .option('--format-cairo', 'Format cairo output')
  .option('--highlight <ids...>')
  .option('--order <passOrder>')
  .option('-o, --output-dir <path>', 'Output directory for transpiled Cairo files.', 'warp_output')
  .option('-d, --debug-info', 'Include debug information.', false)
  .option('--print-trees')
  .option('--no-result')
  .option('--no-stubs')
  .option('--no-strict')
  .option('--until <pass>', 'Stops transpilation after the specified pass')
  .option('--no-warnings')
  .option('--include-paths <paths...>')
  .option('--base-path <path>')
  .action((files: string[], options: CliOptions) => {
    // We do the extra work here to make sure all the errors are printed out
    // for all files which are invalid.
    if (files.map((file) => isValidSolFile(file)).some((result) => !result)) return;

    const [defaultBasePath, defaultIncludePath] = defaultBasePathAndIncludePath();

    if (defaultBasePath !== null && defaultIncludePath !== null) {
      options.includePaths =
        options.includePaths === undefined
          ? [defaultIncludePath]
          : options.includePaths.concat(defaultIncludePath);
      options.basePath = options.basePath || defaultBasePath;
    }

    // map file location relative to current working directory
    const mFiles = files.map((file) => path.relative(process.cwd(), file));

    const ast = compileSolFiles(mFiles, options);
    const contractToHashMap = new Map<string, string>();

    try {
      transpile(ast, options)
        .map(([name, cairo]) => {
          outputResult(name, cairo, options, ast);
          return name;
        })
        .map((file) =>
          postProcessCairoFile(file, options.outputDir, options.debugInfo, contractToHashMap),
        )
        .forEach((file: string) => {
          if (options.compileCairo) {
            const { success, resultPath, abiPath } = compileCairo(
              path.join(options.outputDir, file),
              path.resolve(__dirname, '..'),
              options,
            );
            if (!success) {
              if (resultPath) {
                fs.unlinkSync(resultPath);
              }
              if (abiPath) {
                fs.unlinkSync(abiPath);
              }
            }
          }
        });
    } catch (e) {
      handleTranspilationError(e);
    }
  });

program
  .command('transform <file>')
  .option('--no-compile-errors')
  .option('--check-trees')
  .option('--highlight <ids...>')
  .option('--order <passOrder>')
  .option('-o, --output-dir <path>')
  .option('--print-trees')
  .option('--no-result')
  .option('--no-stubs')
  .option('--no-strict')
  .option('--until <pass>')
  .option('--no-warnings')
  .option('--include-paths <paths...>')
  .option('--base-path <path>')
  .action((file: string, options: CliOptions) => {
    if (!isValidSolFile(file)) return;

    const [defaultBasePath, defaultIncludePath] = defaultBasePathAndIncludePath();

    if (defaultBasePath !== null && defaultIncludePath !== null) {
      options.includePaths =
        options.includePaths === undefined
          ? [defaultIncludePath]
          : options.includePaths.concat(defaultIncludePath);
      options.basePath = options.basePath || defaultBasePath;
    }

    try {
      const mFile = path.relative(process.cwd(), file);
      const ast = compileSolFiles([mFile], options);
      transform(ast, options).map(([name, solidity]) => {
        outputResult(replaceSuffix(name, '_warp.sol'), solidity, options, ast);
      });
    } catch (e) {
      handleTranspilationError(e);
    }
  });

program
  .command('test')
  .option('-f --force')
  .option('-r --results')
  .option('-u --unsafe')
  .option('-e --exact')
  .action((options) =>
    runTests(
      options.force ?? false,
      options.results ?? false,
      options.unsafe ?? false,
      options.exact ?? false,
    ),
  );

program
  .command('analyse <file>')
  .option('--highlight <ids...>')
  .action((file: string, options: PrintOptions) => analyseSol(file, options));

export interface IOptionalNetwork {
  network?: string;
}

program
  .command('status <tx_hash>')
  .option('--network <network>', 'Starknet network URL.', process.env.STARKNET_NETWORK)
  .action((tx_hash: string, options: IOptionalNetwork) => {
    runStarknetStatus(tx_hash, options);
  });

export interface IOptionalDebugInfo {
  debugInfo: boolean;
}

program
  .command('compile <file>')
  .option('-d, --debug-info', 'Include debug information.', false)
  .action((file: string, options: IOptionalDebugInfo) => {
    runStarknetCompile(file, options);
  });

export interface SolcInterfaceGenOptions {
  cairoPath: string;
  output?: string;
  solcVersion?: string;
  contractAddress?: string;
  classHash?: string;
}

program
  .command('gen_interface <file>')
  .option('--cairo-path <cairo-path>', 'Cairo libraries/modules import path')
  .option('--output <output>', 'Output path for the generation of files')
  .option(
    '--contract-address <contract-address>',
    'Address at which cairo contract has been deployed',
  )
  .option('--class-hash <class-hash>', 'Class hash of the cairo contract')
  .option('--solc-version <version>', 'Solc version to use.', '0.8.14')
  .action((file: string, options: SolcInterfaceGenOptions) => {
    generateSolInterface(file, options);
  });

interface IDeployProps_ {
  inputs?: string[];
  use_cairo_abi: boolean;
  no_wallet: boolean;
  wallet?: string;
}

export type IDeployProps = IDeployProps_ & IOptionalNetwork & IOptionalAccount & IOptionalDebugInfo;

program
  .command('deploy <file>')
  .option('-d, --debug_info', 'Compile include debug information.', false)
  .option(
    '--inputs <inputs...>',
    'Arguments to be passed to constructor of the program as a comma seperated list of strings, ints and lists.',
    undefined,
  )
  .option('--use_cairo_abi', 'Use the cairo abi instead of solidity for the inputs.', false)
  .option('--network <network>', 'StarkNet network URL.', process.env.STARKNET_NETWORK)
  .option('--no_wallet', 'Do not use a wallet for deployment.', false)
  .option('--wallet <wallet>', 'Wallet provider to use', process.env.STARKNET_WALLET)
  .option('--account <account>', 'Account to use for deployment', undefined)
  .action((file: string, options: IDeployProps) => {
    runStarknetDeploy(file, options);
  });

interface IOptionalWallet {
  wallet?: string;
}

interface IOptionalAccount {
  account?: string;
}
export type IDeployAccountProps = IOptionalAccount & IOptionalNetwork & IOptionalWallet;

program
  .command('deploy_account')
  .option(
    '--account <account>',
    'The name of the account. If not given, the default for the wallet will be used.',
  )
  .option('--network <network>', 'StarkNet network URL.', process.env.STARKNET_NETWORK)
  .option(
    '--wallet <wallet>',
    'The name of the wallet, including the python module and wallet class.',
    process.env.STARKNET_WALLET,
  )
  .action((options: IDeployAccountProps) => {
    runStarknetDeployAccount(options);
  });

interface ICallOrInvokeProps_ {
  address: string;
  function: string;
  inputs?: string[];
  use_cairo_abi: boolean;
}
export type ICallOrInvokeProps = ICallOrInvokeProps_ &
  IOptionalNetwork &
  IOptionalWallet &
  IOptionalAccount;

program
  .command('invoke <file>')
  .requiredOption('--address <address>', 'Address of contract to invoke.')
  .requiredOption('--function <function>', 'Function to invoke.')
  .option(
    '--inputs <inputs...>',
    'Input to function as a comma separated string, use square brackets to represent lists and structs. Numbers can be represented in decimal and hex.',
    undefined,
  )
  .option('--use_cairo_abi', 'Use the cairo abi instead of solidity for the inputs.', false)
  .option(
    '--account <account>',
    'The name of the account. If not given, the default for the wallet will be used.',
  )
  .option('--network <network>', 'StarkNet network URL.', process.env.STARKNET_NETWORK)
  .option(
    '--wallet <wallet>',
    'The name of the wallet, including the python module and wallet class.',
    process.env.STARKNET_WALLET,
  )
  .action(async (file: string, options: ICallOrInvokeProps) => {
    runStarknetCallOrInvoke(file, false, options);
  });

program
  .command('call <file>')
  .requiredOption('--address <address>', 'Address of contract to call.')
  .requiredOption('--function <function>', 'Function to call.')
  .option(
    '--inputs <inputs...>',
    'Input to function as a comma separated string, use square brackets to represent lists and structs. Numbers can be represented in decimal and hex.',
    undefined,
  )
  .option('--use_cairo_abi', 'Use the cairo abi instead of solidity for the inputs.', false)
  .option(
    '--account <account>',
    'The name of the account. If not given, the default for the wallet will be used.',
  )
  .option('--network <network>', 'StarkNet network URL.', process.env.STARKNET_NETWORK)
  .option(
    '--wallet <wallet>',
    'The name of the wallet, including the python module and wallet class.',
    process.env.STARKNET_WALLET,
  )
  .action(async (file: string, options: ICallOrInvokeProps) => {
    runStarknetCallOrInvoke(file, true, options);
  });

interface IOptionalVerbose {
  verbose: boolean;
}

interface IInstallOptions_ {
  python: string;
}

export type IInstallOptions = IInstallOptions_ & IOptionalVerbose;

program
  .command('install')
  .option('--python <python>', 'Path to python3.9 executable.', 'python3.9')
  .option('-v, --verbose')
  .action((options: IInstallOptions) => {
    runVenvSetup(options);
  });

export interface IDeclareOptions {
  no_wallet: boolean;
  network?: string;
  wallet?: string;
  account?: string;
}

program
  .command('declare <cairo_contract>')
  .description('Command to declare Cairo contract on a StarkNet Network.')
  .option('--network <network>', 'StarkNet network URL.', process.env.STARKNET_NETWORK)
  .option(
    '--account <account>',
    'The name of the account. If not given, the default for the wallet will be used.',
  )
  .option(
    '--wallet <wallet>',
    'The name of the wallet, including the python module and wallet class.',
    process.env.STARKNET_WALLET,
  )
  .action(async (cairo_contract: string, options: IDeclareOptions) => {
    runStarknetDeclare(cairo_contract, options);
  });

const blue = chalk.bold.blue;
const green = chalk.bold.green;
program.command('version').action(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pjson = require('../package.json');
  console.log(blue(`Warp Version `) + green(pjson.version));
});

program.parse(process.argv);
