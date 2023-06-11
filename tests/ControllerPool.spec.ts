import { Blockchain, SandboxContract, internal, TreasuryContract, BlockchainSnapshot } from '@ton-community/sandbox';
import { Cell, toNano, fromNano, Dictionary, beginCell, Address } from 'ton-core';
import { Pool, PoolConfig } from '../wrappers/Pool';
import { Controller, ControllerConfig } from '../wrappers/Controller';
import { JettonMinter as DAOJettonMinter, jettonContentToCell } from '../contracts/jetton_dao/wrappers/JettonMinter';
import { setConsigliere } from '../wrappers/PayoutMinter.compile';
import {JettonWallet as PoolJettonWallet } from '../contracts/jetton_dao/wrappers/JettonWallet';
import {JettonWallet as DepositWallet} from '../contracts/awaited_minter/wrappers/JettonWallet';
import {JettonWallet as WithdrawalWallet} from '../contracts/awaited_minter/wrappers/JettonWallet';
import { getElectionsConf, getValidatorsConf, getVset, loadConfig, packValidatorsSet } from "../wrappers/ValidatorUtils";
import '@ton-community/test-utils';
import { randomAddress } from "@ton-community/test-utils";
import { compile } from '@ton-community/blueprint';
import { findCommon } from '../utils';

const errors = {
    WRONG_SENDER: 0x9283,
    TOO_EARLY_LOAN_REQUEST: 0xfa02,
    TOO_LATE_LOAN_REQUEST: 0xfa03,
    TOO_HIGH_LOAN_REQUEST_AMOUNT: 0xfa04,
    INTEREST_TOO_LOW: 0xf100,
    CONTRADICTING_BORROWING_PARAMS: 0xf101,
    CREDIT_BOOK_TOO_DEEP: 0xf401
};


describe('Controller & Pool', () => {
    let pool_code: Cell;
    let controller_code: Cell;
    let payout_minter_code: Cell;
    let payout_wallet_code: Cell;

    let dao_minter_code: Cell;
    let dao_wallet_code: Cell;
    let dao_vote_keeper_code: Cell;
    let dao_voting_code: Cell;

    let blockchain: Blockchain;
    let pool: SandboxContract<Pool>;
    let controller: SandboxContract<Controller>;
    let poolJetton: SandboxContract<DAOJettonMinter>;
    let deployer: SandboxContract<TreasuryContract>;
    let notDeployer: SandboxContract<TreasuryContract>;
    let normalState: BlockchainSnapshot;
    let poolConfig: PoolConfig;
    let controllerConfig: ControllerConfig;

    jest.setTimeout(60000);

    beforeAll(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = 100

        deployer = await blockchain.treasury('deployer', {balance: toNano("1000000000")});

        await setConsigliere(deployer.address);
        payout_minter_code = await compile('PayoutMinter');
        payout_wallet_code = await compile('PayoutWallet');

        pool_code = await compile('Pool');
        controller_code = await compile('Controller');

        dao_minter_code = await compile('DAOJettonMinter');
        dao_wallet_code = await compile('DAOJettonWallet');
        dao_vote_keeper_code = await compile('DAOVoteKeeper');
        dao_voting_code = await compile('DAOVoting');

        deployer = await blockchain.treasury('deployer', {balance: toNano("1000000000")});
        notDeployer = await blockchain.treasury('notDeployer', {balance: toNano("1000000000")});

        const content = jettonContentToCell({type:1,uri:"https://example.com/1.json"});
        poolJetton  = blockchain.openContract(DAOJettonMinter.createFromConfig({
                                                  admin:deployer.address,
                                                  content,
                                                  voting_code:dao_voting_code,
                                                  },
                                                  dao_minter_code));
        poolConfig = {
              pool_jetton : poolJetton.address,
              pool_jetton_supply : 0n,
              optimistic_deposit_withdrawals: 0n,

              sudoer : deployer.address,
              governor : deployer.address,
              interest_manager : deployer.address,
              halter : deployer.address,
              consigliere : deployer.address,
              approver : deployer.address,

              controller_code : controller_code,
              payout_wallet_code : payout_wallet_code,
              pool_jetton_wallet_code : dao_wallet_code,
              payout_minter_code : payout_minter_code,
              vote_keeper_code : dao_vote_keeper_code,
        };
        pool = blockchain.openContract(Pool.createFromConfig(poolConfig, pool_code));

        controllerConfig = {
          controllerId:0,
          validator: deployer.address,
          pool: pool.address,
          governor: deployer.address,
          approver: deployer.address,
          halter: deployer.address,
        };
        controller = blockchain.openContract(Controller.createFromConfig(controllerConfig, controller_code));

        const poolDeployResult = await pool.sendDeploy(deployer.getSender(), toNano('11'));
        expect(poolDeployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: pool.address,
            deploy: true,
            success: true,
        });
        const poolJettonDeployResult = await poolJetton.sendDeploy(deployer.getSender(), toNano('1.05'));
        expect(poolJettonDeployResult.transactions).toHaveTransaction({
                         from: deployer.address,
                         to: poolJetton.address,
                         deploy: true,
                         success: true,
        });
        // change admin because we need to know jetton address before minting the pool
        const adminTransferResult = await poolJetton.sendChangeAdmin(deployer.getSender(), pool.address);
        expect(adminTransferResult.transactions).toHaveTransaction({
                         on: poolJetton.address,
                         success: true,
        });
        const controllerDeployResult = await pool.sendRequestControllerDeploy(deployer.getSender(), toNano('100000'), 0);
        expect(controllerDeployResult.transactions).toHaveTransaction({
            from: pool.address,
            to: controller.address,
            deploy: true,
            success: true,
        });
        const approveResult = await controller.sendApprove(deployer.getSender());
        expect(approveResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: controller.address,
            success: true,
        });
        const depositResult = await pool.sendDeposit(deployer.getSender(), toNano('320000'));
        expect(depositResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: pool.address,
            success: true,
        });
        const confDict = loadConfig(blockchain.config);
        confDict.set(34, beginCell().storeUint(0x12, 8)
                     .storeUint(100000, 32) // time since
                     .storeUint(200000, 32) // time until
                     .endCell());
        blockchain.setConfig(beginCell().storeDictDirect(confDict).endCell());
        const reqWindowTime = await controller.getRequestWindow();
        blockchain.now = reqWindowTime.since + 1;
        
        normalState = blockchain.snapshot();
    });

    afterEach(async () => {
        await blockchain.loadFrom(normalState);
    });

    it('should deploy and deposit', async () => {});

    describe('Loan request', () => {
        const loanRequestParams: [bigint, bigint, number] = [ toNano('100000'), toNano('320000'), 1000 ];
        const loanRequestBody = Controller.loanRequestBody(...loanRequestParams);
        let loanRequestBodyToPool: Cell;
        const loanRequestControllerIntoPool: (reqBody: Cell, controllerId: number, valik: Address) => Cell =
            (reqBody, controllerId, valik) => {
                    return beginCell()
                    .storeUint(0x7ccd46e9, 32) // op pool::request_loan
                    // skip part with requesting to send a request to pool from controller
                    // send request to pool directly
                    .storeSlice(
                        reqBody
                        .beginParse().skip(32)) // - op. the rest of request
                    .storeRef( // static data
                        beginCell()
                        .storeUint(controllerId, 32)
                        .storeAddress(valik))
                    .endCell();
        }

        it('should accept standart loan', async () => {
            const requestLoanResult = await controller.sendLoanRequest(deployer.getSender(), ...loanRequestParams);
            expect(requestLoanResult.transactions).toHaveTransaction({
                from: deployer.address,
                to: controller.address,
                success: true,
            });
        });
        it('should not accept from random address', async () => {
            loanRequestBodyToPool = loanRequestControllerIntoPool(loanRequestBody, 0, deployer.address);
            const fakeRandController = await blockchain.treasury('fakeRandController');
            const requestLoanResult = await fakeRandController.send({
                to: pool.address,
                value: toNano('0.5'),
                body: loanRequestBodyToPool,
            });
            expect(requestLoanResult.transactions).toHaveTransaction({
                to: pool.address,
                success: false,
                exitCode: errors.WRONG_SENDER,
            });
        });
        it('should not accept loan from another pool\'s controller', async () => {
            let anotherPoolConfig = {...poolConfig};
            anotherPoolConfig.sudoer = randomAddress(); // just to change the address
            const anotherPool = blockchain.openContract(Pool.createFromConfig(anotherPoolConfig, pool_code));
            let anotherControllerConfig = {...controllerConfig};
            anotherControllerConfig.pool = anotherPool.address;
            const anotherController = blockchain.openContract(Controller.createFromConfig(anotherControllerConfig, controller_code));

            const poolSmc = await blockchain.getContract(pool.address);

            const requestLoanResult = poolSmc.receiveMessage(internal({
                from: anotherController.address,
                to: pool.address,
                value: toNano('0.5'),
                body: loanRequestBodyToPool
            }));
            expect(requestLoanResult.outMessagesCount).toEqual(1);
            const bounced = requestLoanResult.outMessages.get(0)!
            expect(requestLoanResult.vmLogs).toContain("terminating vm with exit code " + errors.WRONG_SENDER);
            expect(bounced.body.beginParse().loadUint(32)).toEqual(0xFFFFFFFF);
        });
        it('should not accept loan from another approver\'s controller', async () => {
            let anotherPoolConfig = {...poolConfig};
            const approver = await blockchain.treasury('approver');
            anotherPoolConfig.approver = approver.address;
            const anotherPool = blockchain.openContract(Pool.createFromConfig(anotherPoolConfig, pool_code));
            let anotherControllerConfig = {...controllerConfig};
            anotherControllerConfig.pool = anotherPool.address;
            const anotherController = blockchain.openContract(Controller.createFromConfig(anotherControllerConfig, controller_code));

            const poolSmc = await blockchain.getContract(pool.address);
            const requestLoanResult = poolSmc.receiveMessage(internal({
                from: anotherController.address,
                to: pool.address,
                value: toNano('0.5'),
                body: loanRequestBodyToPool
            }));
            expect(requestLoanResult.vmLogs).toContain(
                "terminating vm with exit code " + errors.WRONG_SENDER);
        });
        it('should not accept loan from controller not from the masterchain', async () => {
            const basechainController = blockchain.openContract(
                Controller.createFromConfig(
                    controllerConfig, controller_code, 0));
            let deployResult = await basechainController.sendDeploy(deployer.getSender());
            let approveResult = await basechainController.sendApprove(deployer.getSender());
            expect([...approveResult.transactions, ...deployResult.transactions])
                   .not.toHaveTransaction({ success: false });

            const requestLoanResult = await basechainController.sendLoanRequest(deployer.getSender(), ...loanRequestParams);
            expect(requestLoanResult.transactions).toHaveTransaction({
                from: basechainController.address,
                to: pool.address,
                success: false,
                exitCode: errors.WRONG_SENDER,
            });
        });
        it('should not accept loan with low interest rate', async () => {
            const { interestRate } = await pool.getFinanceData();
            const requestLoanResult1 = await controller.sendLoanRequest(deployer.getSender(), toNano('100000'), toNano('320000'), interestRate - 1);
            expect(requestLoanResult1.transactions).toHaveTransaction({
                from: controller.address,
                to: pool.address,
                success: false,
                exitCode: errors.INTEREST_TOO_LOW,
            });
            const requestLoanResult2 = await controller.sendLoanRequest(deployer.getSender(), toNano('100000'), toNano('320000'), interestRate);
            expect(requestLoanResult2.transactions).toHaveTransaction({ to: pool.address, success: true });
        });
        it('should not accept a small loan', async () => {
            const { min } = await pool.getMinMaxLoanPerValidator();
            const requestLoanResult = await controller.sendLoanRequest(deployer.getSender(), min-1n, min-1n, 1000);
            expect(requestLoanResult.transactions).toHaveTransaction({
                from: controller.address,
                to: pool.address,
                success: false,
                exitCode: errors.CONTRADICTING_BORROWING_PARAMS,
            });
        });
        it('should not accept a big one', async () => {
            const { max } = await pool.getMinMaxLoanPerValidator();
            const requestLoanResult = await controller.sendLoanRequest(deployer.getSender(), max+1n, max+1n, 1000);
            expect(requestLoanResult.transactions).toHaveTransaction({
                from: controller.address,
                to: pool.address,
                success: false,
                exitCode: errors.CONTRADICTING_BORROWING_PARAMS,
            });
        });

        it('should test max depth of borrowers dict', async () => {
            // hashmap are compact binary trees, so we need to
            // test the max depth of the splitting by generating
            // addresses with different prefixes (0b0000, 0b0001, 0b0010, ...)
            let controllerId = 0;
            function nextController(): Controller {
                let config = {...controllerConfig};
                controllerId++;
                config.controllerId = controllerId;
                return Controller.createFromConfig(config, controller_code);
            }
            function tobin(addr: Address): string {
                // address hash to binary string
                const hashPart = '0x' + addr.hash.toString('hex');
                return BigInt(hashPart).toString(2).padStart(256, '0');
            }

            const MAX_DEPTH = 12;
            const mainAddr = controller.address;

            const mainAddrBin = tobin(mainAddr);
            const commons: number[] = [];

            let controllers: {id: number, addr: Address}[] = [ {id: 0, addr: mainAddr} ];
            while (controllers.length < MAX_DEPTH + 1) {
                let next = nextController();
                const common = findCommon(mainAddrBin, tobin(next.address));
                if (commons.indexOf(common) === -1) {
                    controllers.push(
                        {id: controllerId, addr: next.address}
                    );
                    commons.push(common);
                }
            }
            const loanLimits = await pool.getMinMaxLoanPerValidator();
            const poolSmc = await blockchain.getContract(pool.address);
            let minLoanRequestBody = Controller.loanRequestBody(loanLimits.min, loanLimits.min, 1000);
            for (let i = 0; i < MAX_DEPTH; i++) {
                const {id, addr} = controllers[i];

                let body = loanRequestControllerIntoPool(minLoanRequestBody, id, deployer.address);
                let result = poolSmc.receiveMessage(internal({
                    from: addr,
                    to: pool.address,
                    value: toNano('0.5'),
                    body: body
                }));
                // limit reached
                expect(result.vmLogs).not.toContain("terminating vm with exit code");
            }
            const {id, addr} = controllers[MAX_DEPTH];
            let body = loanRequestControllerIntoPool(minLoanRequestBody, id, deployer.address);
            let result = poolSmc.receiveMessage(internal({
                from: addr,
                to: pool.address,
                value: toNano('0.5'),
                body: body
            }));
            expect(result.vmLogs).toContain("terminating vm with exit code " + errors.CREDIT_BOOK_TOO_DEEP);
        });
    });
});
