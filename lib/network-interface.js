var web3Utils = require('web3-utils')
const Tx = require('ethereumjs-tx')
const Vault = require("./vault");
const miningLogger = require("./mining-logger");
//var tokenContractJSON = require('../contracts/_0xMithrilToken.json');
var tokenContractJSON = require('../contracts/MineableToken.json');

var busySendingSolution = false;
var queuedMiningSolutions = [];

var lastSubmittedMiningSolutionChallengeNumber;

module.exports = {
    init(web3, vault, miningLogger) {
        this.web3 = web3;
        this.tokenContract = new web3.eth.Contract(tokenContractJSON.abi, vault.getTokenContractAddress())
        console.log('using contract address', vault.getTokenContractAddress());
        this.miningLogger = miningLogger;
        this.vault = vault;

        busySendingSolution = false;

        setInterval(() => { this.sendMiningSolutions() }, 500)
    },

    async checkMiningSolution(addressFrom, solution_number, challenge_digest, challenge_number, target, callback) {

        this.tokenContract.methods.checkMintSolution(solution_number, challenge_digest, challenge_number, target).call(callback)
    },

    async sendMiningSolutions() {
        //  miningLogger.print( 'sendMiningSolutions' )
        if (busySendingSolution == false) {
            if (queuedMiningSolutions.length > 0) {
                //busySendingSolution = true;
                var nextSolution = queuedMiningSolutions.pop();

                this.miningLogger.appendToStandardLog("Popping queued mining solution " + nextSolution.toString())

                if (nextSolution.challenge_number != lastSubmittedMiningSolutionChallengeNumber) {
                    lastSubmittedMiningSolutionChallengeNumber = nextSolution.challenge_number;
                    //miningLogger.print('popping mining solution off stack ')

                    try {
                        var response = await this.submitMiningSolution(nextSolution.addressFrom, nextSolution.minerEthAddress,
                            nextSolution.solution_number, nextSolution.challenge_digest);
                        if (response instanceof Error) {
                            miningLogger.print("Got error trying to send transaction");
                            // reset 'last' challenge number so solution is sent again. 
                            lastSubmittedMiningSolutionChallengeNumber = "";
                        } else {
                            miningLogger.print("-->txhash:", response)
                        }
                    } catch (e) {
                        this.miningLogger.appendToErrorLog(e)
                        miningLogger.print(e);
                    }
                }

                busySendingSolution = false;
            }
        }
    },

    async collectMiningParameters() {
        let account = await this.vault.getAccount().address;
        var miningDifficultyString = await this.tokenContract.methods.getMiningDifficulty().call({from: account});
        var miningDifficulty = parseInt(miningDifficultyString)

        var miningTargetString = await this.tokenContract.methods.getMiningTarget().call({from: account});
        var miningTarget = web3Utils.toBN(miningTargetString)

        var challengeNumber = await this.tokenContract.methods.getChallengeNumber().call({from: account});

        //miningLogger.print('Mining difficulty:', miningDifficulty);
        //miningLogger.print('Challenge number:', challengeNumber)

        return {
            miningDifficulty: miningDifficulty,
            challengeNumber: challengeNumber,
            miningTarget: miningTarget
        };

    },

    queueMiningSolution(addressFrom, minerEthAddress, solution_number, challenge_digest, challenge_number, target, difficulty) {

        //miningLogger.print('pushed solution to stack')
        queuedMiningSolutions.push({
            addressFrom: addressFrom,
            minerEthAddress: minerEthAddress,
            solution_number: solution_number,
            challenge_digest: challenge_digest,
            challenge_number: challenge_number
        });

    },

    async submitMiningSolution(addressFrom, minerEthAddress, solution_number, challenge_digest) {

        //  var addressFrom = this.vault.getAccount().public_address ;
        this.miningLogger.appendToStandardLog("Submitting Solution " + challenge_digest)

        //console.log('\n')
        miningLogger.print('---Submitting solution for reward---')
        miningLogger.print('nonce ', solution_number)
        miningLogger.print('challenge_digest ', challenge_digest)
        //console.log('\n')

        // var mintMethod = this.tokenContract.methods.mint(solution_number, challenge_digest);

        // ERC 918 compatibility
        var mintMethod = this.tokenContract.methods.mint(solution_number);

        try {
            var txCount = await this.web3.eth.getTransactionCount(minerEthAddress);
            miningLogger.print('txCount', txCount)
        } catch (error) {  //here goes if someAsyncPromise() rejected}
            miningLogger.print(error);
            this.miningLogger.appendToErrorLog(error)
            return error;    //this will result in a resolved promise.
        }

        var addressTo = this.tokenContract.options.address;
        /*
        var txData = this.web3.eth.abi.encodeFunctionCall({
            name: 'mint',
            type: 'function',
            inputs: [{
                type: 'uint256',
                name: 'nonce'
            }, {
                type: 'bytes32',
                name: 'challenge_digest'
            }]
        }, [solution_number, challenge_digest]);
        */
        // ERC 918 compatibility
        var txData = this.web3.eth.abi.encodeFunctionCall({
            name: 'mint',
            type: 'function',
            inputs: [{
                type: 'uint256',
                name: 'nonce'
            }]
        }, [solution_number]);

        var max_gas_cost = 1704624;
        try {
            var estimatedGasCost = await mintMethod.estimateGas({ gas: max_gas_cost, from: minerEthAddress, to: addressTo });
        } catch (error) {
            miningLogger.print('Error in estimateGas', txCount);
            return error;
        }

        miningLogger.print('estimatedGasCost', estimatedGasCost);
        miningLogger.print('txData', txData);
        miningLogger.print('minerEthAddress', minerEthAddress);
        miningLogger.print('addressTo', addressTo);

        if (estimatedGasCost > max_gas_cost) {
            miningLogger.print("Gas estimate too high!  Something went wrong ")
            return new Error("Gas estimate too high!  Something went wrong ");
        }

        const txOptions = {
            nonce: web3Utils.toHex(txCount),
            gas: web3Utils.toHex(estimatedGasCost),   //?
            gasPrice: web3Utils.toHex(this.vault.getGasPriceWei()),
            value: 0,
            to: addressTo,
            from: minerEthAddress,
            data: txData
        }

        return new Promise((result, error) => {
            this.sendSignedRawTransaction(this.web3, txOptions, addressFrom, this.vault, (err, res) => {
                if (err) error(err)
                result(res)
            })
        });
    },

    async sendSignedRawTransaction(web3, txOptions, addressFrom, vault, callback) {
        var fullPrivKey = vault.getFullAccount().privateKey;
        var privKey = this.truncate0xFromString(fullPrivKey)

        const privateKey = new Buffer(privKey, 'hex')
        const transaction = new Tx(txOptions)

        transaction.sign(privateKey)

        const serializedTx = transaction.serialize().toString('hex')

        try {
            var result = web3.eth.sendSignedTransaction('0x' + serializedTx, callback)
        } catch (e) {
            miningLogger.print(e);
        }
    },

    truncate0xFromString(s) {
        if (s.startsWith('0x')) {
            return s.substring(2);
        }
        return s;
    }
}
