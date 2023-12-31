import { activeContractsList } from '@aragon/osx-ethers';
import {
    ApplyInstallationParams,
    DaoAction,
    MetadataAbiInput,
    PrepareInstallationParams,
} from '@aragon/sdk-client-common';
import { ProposalCreationStepValue, VoteValues } from '@aragon/sdk-client';
import { Client, TokenVotingClient, MultisigClient } from '../lib/sdk';
import { getWallet } from '../lib/helpers';
import { AllowedNetwork, RepoAddress } from '../lib/constants';
import { ethers } from 'ethers';
import * as metadata from './../../../subdao-plugin/src/build-metadata.json';
const log = console.log;

import { parse, ArgumentConfig } from 'ts-command-line-args';

const meta = import.meta as any;

export const TOKEN_VOTING_PLUGIN_ID = 'token-voting.plugin.dao.eth';
export const MULTISIG_PLUGIN_ID = 'multisig.plugin.dao.eth';

if (meta.main) {
    // Define the configuration for the command-line arguments
    interface MyArgs {
        childDaoAddress: string;
        parentDaoAddress: string;
        network: string;
    }

    // Define the argument configuration
    const config: ArgumentConfig<MyArgs> = {
        childDaoAddress: {
            type: String,
            alias: 'c',
            description: 'The child dao address or ENS',
        },
        parentDaoAddress: {
            type: String,
            alias: 'p',
            description: 'The parent dao address or ENS',
        },
        network: {
            type: String,
            alias: 'n',
            description: 'The network, can be one of [mainnet, goerli, polygon, mumbai, base, baseGoerli, local]',
        },
    };

    const args = parse<MyArgs>(config);

    const childDAO = args.childDaoAddress;
    const parentDAO = args.parentDaoAddress;
    const network: AllowedNetwork = args.network as AllowedNetwork;
    installSubDaoPlugin(childDAO, parentDAO, network);
}


export async function installSubDaoPlugin(childDAO: string, parentDAO: string, network: AllowedNetwork) {
    // ============================================================
    // 0. Setup: Get all the addresses and contracts
    // ============================================================
    // ***0a. Setup Aragon stuff***
    const subDAORepoAddress = RepoAddress[network];
    const deployer = getWallet();
    const client = Client(network);
    const tokenVotingClient = TokenVotingClient(network);
    const multisigClient = MultisigClient(network);

    // get the dao details
    const childDaoDetails = await client.methods.getDao(childDAO);
    if (!childDaoDetails) throw new Error('DAO not found');
    const parentDaoDetails = await client.methods.getDao(parentDAO);
    if (!parentDaoDetails) throw new Error('DAO not found');

    const childDAOAddress = childDaoDetails.address;
    const parentDaoAddress = parentDaoDetails.address;
    const {votingPluginAddress, votingPluginType} = getVotingPluginAddress(childDaoDetails);

    log('Deployer wallet address: ', deployer.address);
    log('Child DAO Contract: ', childDAOAddress);
    log('Parent DAO Contract: ', parentDaoAddress);
    log('Voting Plugin address: ', votingPluginAddress);
    log('Child DAO Plugins', childDaoDetails.plugins);
    log('SubDAO Repo Address', subDAORepoAddress);

    // ==============================================================
    // 1. PrepareInstallation: Using the PluginSetupProcessor, prepare the installation
    // https://github.com/aragon/osx/blob/a52bbae69f78e74d6a17647370ccfa2f2ea9bbf0/packages/contracts/src/framework/plugin/setup/PluginSetupProcessor.sol#L287-L288
    // ==============================================================

    // 1a. ***Prepare the installation metadata***
    // This is the metadata that is needed to initialize the plugin. Its the the same thing that is encoded in the setup contract
    // https://devs.aragon.org/docs/osx/how-to-guides/plugin-development/publication/metadata
    const setupAbiMetadata: MetadataAbiInput[] = [
        {
            "internalType": "address",
            "name": "_data",
            "type": "address",
            "description": "parent contract address"
        }
    ];

    // 1b. ***Prepare the installation params***
    // const data = ethers.utils.defaultAbiCoder.encode(['address'], [parentDaoAddress]);
    const setupParams = [parentDaoAddress];

    // 1c. ***Prepare the installation***
    const prepareInstallParams: PrepareInstallationParams = {
        daoAddressOrEns: childDAOAddress,
        pluginRepo: subDAORepoAddress,
        installationAbi: setupAbiMetadata,
        installationParams: setupParams,
    };

    log('Prepare Installation...');
    // 1d. ***Call the prepareInstallation() on the SDK **
    // This returns an async generator that will return the steps as they are completed
    const prepareSteps = client.methods.prepareInstallation(prepareInstallParams);

    // 1e. ***Iterate through the steps***
    const prepareInstallStep1 = await (await prepareSteps.next()).value;
    log('Transaction Hash: ', prepareInstallStep1.txHash);

    const prepareInstallStep2 = await (await prepareSteps.next()).value;
    log('Installation Data: ', prepareInstallStep2);
    
    // this is already an object that has all the data we need to apply the installation. it also has the Key from the iterator but we dont need that
    const installdata = prepareInstallStep2 satisfies ApplyInstallationParams;
    log('SubDAO plugin address', installdata.pluginAddress)

    // ==============================================================
    // 2. Create Proposal to Apply install: Using the PluginSetupProcessor, use the SDK to get the set of actions and create a proposal
    // https://github.com/aragon/osx/blob/a52bbae69f78e74d6a17647370ccfa2f2ea9bbf0/packages/contracts/src/framework/plugin/setup/PluginSetupProcessor.sol#L287-L288
    // ==============================================================

    // 2a. ***Encode the actions***
    // Here we use the client to create the encoded actions. This creates 3 actions,
    // [0] Grants the PSP permission to install,
    // [1] Installs the plugin,
    // [2] Removes the PSP permission to install
    const daoActions: DaoAction[] = client.encoding.applyInstallationAction(childDAOAddress, installdata);

    // 2b. ***Pin the metadata***
    const proposalMetadata = {
        title: 'Sub-DAO plugin installation',
        summary: 'Granting parent DAO execution permission on child dao',
        description: `By installing this plugin, the plugin will grant the execution access of child dao (${childDAO}) to parent dao (${parentDAO})`,
        resources: [
            {
                url: 'https://patterns.community',
                name: 'Pattern',
            },
        ],
        media: {
            header: 'https://assets-global.website-files.com/65410dc30116ce87ecbef5cd/654f75bc7db9aa282ca87e21_Logo%2Btext%20White.png',
            logo: 'https://assets-global.website-files.com/65410dc30116ce87ecbef5cd/654f75bc7db9aa282ca87e21_Logo%2Btext%20White.png',
        },
    };

    if (votingPluginType === TOKEN_VOTING_PLUGIN_ID) {
        const metadataUri: string = await tokenVotingClient.methods.pinMetadata(proposalMetadata);
        // 2c. ***Create the proposal***
        // this returns an export generator that will create the proposal
        const createProposalSteps = tokenVotingClient.methods.createProposal({
            metadataUri,
            pluginAddress: votingPluginAddress,
            actions: daoActions,
            creatorVote: VoteValues.YES, // creator votes yes
            executeOnPass: true, // execute on pass
            startDate: new Date(0), // Start immediately
            endDate: new Date(0), // uses minimum voting duration
        });
        await iterateSteps(createProposalSteps);
    } else if (votingPluginType === MULTISIG_PLUGIN_ID) {
        const metadataUri: string = await multisigClient.methods.pinMetadata(proposalMetadata);
        const createProposalSteps = multisigClient.methods.createProposal({
            metadataUri,
            pluginAddress: votingPluginAddress,
            actions: daoActions,
            approve: true,
            tryExecution: true,
            startDate: new Date(0), // Start immediately
            endDate: new Date(new Date().setFullYear(new Date().getFullYear() + 10)), // uses minimum voting duration
        });
        await iterateSteps(createProposalSteps);
    }
}

export async function iterateSteps(createProposalSteps: AsyncGenerator<ProposalCreationStepValue, any, unknown>) {
    // 2d. ***Iterate through the steps***
    const createProposalStep1Value = await (await createProposalSteps.next()).value;
    log('Transaction Hash: ', await createProposalStep1Value.txHash);

    const createProposalStep2Value = await (await createProposalSteps.next()).value;
    log('Proposal ID: ', await createProposalStep2Value.proposalId);
}

export function getVotingPluginAddress(daoDetails){
    const votingPlugin = daoDetails.plugins.filter((e: { id: string; }) =>
        [TOKEN_VOTING_PLUGIN_ID, MULTISIG_PLUGIN_ID].includes(e.id)
    );

    if (votingPlugin.length === 0) throw new Error('Can not find the voting plugin');

    const votingPluginAddress = votingPlugin[0].instanceAddress;
    return {
        votingPluginAddress: votingPlugin[0].instanceAddress,
        votingPluginType: votingPlugin[0].id
    }
}
