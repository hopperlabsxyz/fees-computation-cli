import { BPS_DIVIDER, YEAR_IN_SECONDS } from "../constants";
import type {
  Deposit,
  DepositRequest,
  DepositRequestCanceled,
  RedeemRequest,
  SettleDeposit,
  SettleRedeem,
  TotalAssetsUpdated,
  Transfer,
  RatesUpdated,
  FeeReceiverUpdated,
} from "../../gql/graphql";

import { erc20Abi, maxUint256, zeroAddress, type Address } from "viem";
import type { ReferralConfig, ReferralCustom } from "types/Vault";
import { publicClient } from "lib/publicClient";
import { convertBigIntToNumber, convertToShares } from "utils/convertTo";
import type {
  DealEvent,
  PeriodFees,
  PointEvent,
  ProcessEventParams,
  ProcessEventsParams,
  Rates,
} from "./types";
import { SolidityMath } from "utils/math";
import { PointTracker } from "./pointTracker";
import { UserAccount } from "./userAccount";
import { RatesManager } from "./rates";
import { fetchVault } from "utils/fetchVault";
import { fetchVaultStateUpdateds } from "utils/fetchVaultStateUpdateds";

export async function generateVault({
  vault,
}: {
  vault: { address: Address; chainId: number };
}): Promise<Vault> {
  const stateUpdateds = await fetchVaultStateUpdateds({
    chainId: vault.chainId,
    vaultAddress: vault.address,
  });
  if (!stateUpdateds || stateUpdateds.stateUpdateds.length == 0)
    throw new Error(`Vault ${vault.address} doesn't exist`);
  const vaultData = await fetchVault({
    ...vault,
    block: BigInt(stateUpdateds.stateUpdateds[0].blockNumber),
  });

  return new Vault({
    feeReceiver: vaultData.feesReceiver,
    decimals: vaultData.decimals,
    asset: vaultData.asset,
    rates: vaultData.rates.rates,
    cooldown: vaultData.cooldown,
    silo: vaultData.silo,
  });
}

class Vault {
  public totalSupply = 0n;
  public totalAssets = 0n;
  public lastTotalAssetsUpdateTimestamp = 0;
  public nextManagementFees = 0n;
  public decimals: number;
  public feeReceiver: Address;
  public silo: Address;
  private pointTracker = new PointTracker();

  private ratesManager: RatesManager;

  public asset: { address: Address; decimals: number };

  public periodFees: PeriodFees = [];

  public prePendingDeposits: Record<Address, bigint | undefined> = {};
  public prePendingRedeems: Record<Address, bigint | undefined> = {};

  public pendingDeposits: Record<Address, bigint | undefined> = {};
  public pendingRedeems: Record<Address, bigint | undefined> = {};

  // We need a 2 step referral system here in case a user cancel his deposits.
  // In this case the referral is voided.
  public preReferrals: Record<Address, ReferralConfig | undefined> = {}; // first address is referee, second is referrer
  public referrals: Record<Address, ReferralConfig | undefined> = {};

  private accounts: Record<Address, UserAccount> = {};
  private alternateZeroOne = this.createAlternateFunction();

  // DEBUG //
  public accumulatedFees = 0n;

  constructor({
    feeReceiver,
    decimals,
    cooldown,
    rates,
    asset,
    silo,
  }: {
    feeReceiver: Address;
    silo: Address;
    decimals: number;
    cooldown: number;
    rates: Rates;
    asset: { address: Address; decimals: number };
  }) {
    this.feeReceiver = feeReceiver;
    this.decimals = decimals;

    this.accounts[feeReceiver] = new UserAccount(feeReceiver);

    this.ratesManager = new RatesManager(rates, cooldown);
    this.asset = asset;
    this.silo = silo;
  }

  private depositRequest(event: DepositRequest) {
    const depositRequest = event as DepositRequest;
    const depositUser = depositRequest.controller;

    if (this.prePendingDeposits[depositUser] === undefined)
      this.prePendingDeposits[depositUser] = 0n;
    // we put those assets in prePendingDeposit because users can still cancel
    this.prePendingDeposits[depositUser] += depositRequest.assets;
  }

  private redeemRequest(event: RedeemRequest) {
    const redeemRequest = event as RedeemRequest;
    const redeemUser = redeemRequest.owner;
    if (this.prePendingRedeems[redeemUser] === undefined)
      this.prePendingRedeems[redeemUser] = 0n;

    this.prePendingRedeems[redeemUser] += redeemRequest.shares;
  }

  private handleTotalAssetsUpdated(event: TotalAssetsUpdated) {
    //
    this.totalAssets = event.totalAssets;

    // this is for usual computation
    // compute 4% of annual fees value in shares
    if (this.lastTotalAssetsUpdateTimestamp != 0) {
      const timepast =
        Number(event.blockTimestamp) - this.lastTotalAssetsUpdateTimestamp;
      const ratioOverAYear = YEAR_IN_SECONDS / Number(timepast);
      const percentToDeposit =
        this.feeRates(event.blockNumber).management / ratioOverAYear;

      const assetsToDeposits = Math.trunc(
        percentToDeposit * Number(this.totalAssets)
      );

      // this is to compute the repartition between management and performance fees
      this.nextManagementFees = convertToShares({
        assets: BigInt(assetsToDeposits),
        totalAssets: this.totalAssets - BigInt(assetsToDeposits),
        totalSupply: this.totalSupply,
      });
    }

    const rates = this.feeRates(event.blockTimestamp);
    this.periodFees.push({
      managementFees: "0",
      blockNumber: Number(event.blockNumber),
      performanceFees: "0",
      period: this.periodFees.length,
      timestamp: Number(event.blockTimestamp),
      managementRate: rates.management,
      performanceRate: rates.performance,
      pricePerShare: convertBigIntToNumber(
        this.pricePerShare(),
        this.asset.decimals
      ),
    });
    this.lastTotalAssetsUpdateTimestamp = event.blockTimestamp;
  }

  private handleNewTotalAssetsUpdated() {
    // all the prePendingDeposits are ready to be settle, we can promute them
    // to the pendingDeposits mapping
    for (const [address, deposited] of Object.entries(
      this.prePendingDeposits
    )) {
      if (!this.pendingDeposits[address as Address])
        this.pendingDeposits[address as Address] = 0n;

      this.pendingDeposits[address as Address]! += deposited!;
    }

    // same logic for the redeem
    for (const [address, deposited] of Object.entries(this.prePendingRedeems)) {
      if (!this.pendingRedeems[address as Address])
        this.pendingRedeems[address as Address] = 0n;

      this.pendingRedeems[address as Address]! += deposited!;
    }

    // we reinitialized both
    this.prePendingDeposits = {};
    this.prePendingRedeems = {};
  }

  private handleDeposit(event: Deposit) {
    const { sender, owner, shares } = event;
    const receiver = owner;
    const controller = sender;
    if (controller.toLowerCase() === receiver.toLowerCase()) return; // in this case the balance are already just

    this.getAndCreateAccount(receiver).increaseBalance(shares);
    this.getAndCreateAccount(controller).decreaseBalance(shares);
  }

  private handleDepositRequestCanceled(event: DepositRequestCanceled) {
    this.prePendingDeposits[event.controller] = 0n;
    this.preReferrals[event.controller] = undefined;
  }

  private handleSettleDeposit(event: SettleDeposit) {
    const { sharesMinted, assetsDeposited, totalSupply, totalAssets } = event;

    this.totalSupply = totalSupply;
    this.totalAssets = totalAssets;
    // for each users who has pending deposit:
    for (const [address, userRequest] of Object.entries(this.pendingDeposits)) {
      // we initiate his accounts
      const acc = this.getAndCreateAccount(address as Address);

      // we increase it's balance (like if he claimed his shares)
      acc.increaseBalance(
        SolidityMath.mulDivRounding(
          userRequest!,
          sharesMinted,
          assetsDeposited,
          SolidityMath.Rounding.Ceil
        )
      );
      // we don't update total supply because it will naturally be updated via the transfer
    }
    this.pendingDeposits = {};

    for (const [referee, config] of Object.entries(this.preReferrals)) {
      if (!this.referrals[referee as Address]) {
        this.referrals[referee as Address] = config;
      }
    }
    this.preReferrals = {};
    const periodLength = this.periodFees.length;
    const lastPeriod = this.periodFees[periodLength - 1];
    lastPeriod.pricePerShare = convertBigIntToNumber(
      this.pricePerShare(),
      this.asset.decimals
    );
  }

  private handleSettleRedeem(event: SettleRedeem) {
    this.totalSupply = event.totalSupply;
    this.totalAssets = event.totalAssets;

    for (const [address, redeemed] of Object.entries(this.pendingRedeems)) {
      if (this.accounts[address as Address]) {
        // why this check ?
        this.accounts[address as Address].decreaseBalance(redeemed || 0n);
      }
    }
    this.pendingRedeems = {};
    const periodLength = this.periodFees.length;
    const lastPeriod = this.periodFees[periodLength - 1];
    lastPeriod.pricePerShare = convertBigIntToNumber(
      this.pricePerShare(),
      Number(this.asset.decimals)
    );
  }

  private createAlternateFunction(): () => bigint {
    let lastValue = 1n; // Commence à 1 pour que le premier appel retourne 0

    return function alternateZeroOne(): bigint {
      lastValue = lastValue === 0n ? 1n : 0n; // Alterne entre 0 et 1
      return lastValue;
    };
  }

  private handleFeeReceiverUpdateds(event: FeeReceiverUpdated) {
    this.feeReceiver = event.newReceiver;
  }

  private handleRatesUpdateds(event: RatesUpdated) {
    this.ratesManager.handleRatesUpdated({
      blockTimestamp: event.blockTimestamp,
      rates: {
        management: event.newRate_managementRate,
        performance: event.newRate_performanceRate,
      },
    });
  }

  public feeRates(blockTimestamp: number) {
    return this.ratesManager.feeRates(blockTimestamp);
  }

  private handleTransfer(event: Transfer, distributeFees: boolean) {
    // we initiate the accounts if it is not
    const to: UserAccount = this.getAndCreateAccount(event.to);
    const from: UserAccount = this.getAndCreateAccount(event.from);

    // this is a fee transfer
    if (
      this.feeReceiver.toLowerCase() == event.to.toLowerCase() &&
      event.from == zeroAddress
    ) {
      this.handleFeeTransfer(event, distributeFees);
    }

    // we decrement the balance of the sender
    if (event.from == zeroAddress)
      this.totalSupply += BigInt(event.value); // mint
    else {
      from.decreaseBalance(BigInt(event.value)); // transfer
    }
    // we initiate the accounts if it is not

    if (event.to == zeroAddress)
      this.totalSupply -= BigInt(event.value); // burn
    // we increment the balance of the receiver
    else to.increaseBalance(BigInt(event.value)); //transfer
  }

  private getAndCreateAccount(address: Address): UserAccount {
    if (!this.accounts[address])
      this.accounts[address] = new UserAccount(address);
    return this.accounts[address];
  }

  private handleFeeTransfer(event: Transfer, distributeFees: boolean) {
    const totalFees = BigInt(event.value);

    // we compute how much fees they paid for this epoch
    // we emulated the rounding system of openzeppelin by adding 0 or 1
    if (distributeFees) {
      this.accumulatedFees += totalFees;
      for (const acc of Object.values(this.accounts)) {
        if (acc.address == zeroAddress) continue;
        acc.increaseFees(
          (acc.getBalance() * totalFees) / this.totalSupply +
            this.alternateZeroOne()
        );
        // if (acc.address == zeroAddress) console.log(acc.getFees());
      }
      const periodLength = this.periodFees.length;
      const lastPeriod = this.periodFees[periodLength - 1];
      lastPeriod.managementFees = this.nextManagementFees.toString();
      lastPeriod.performanceFees = (
        totalFees - this.nextManagementFees
      ).toString();
    }
  }

  private handleReferral(event: ReferralCustom) {
    if (event.owner === event.referral) return;
    if (this.preReferrals[event.owner]) return;
    else {
      this.preReferrals[event.owner] = {
        feeRewardRate: event.feeRewardRate,
        feeRebateRate: event.feeRebateRate,
        referrer: event.referral,
      };
    }
  }

  public pricePerShare(): bigint {
    const decimalsOffset = this.decimals - this.asset.decimals;
    return (
      ((this.totalAssets + 1n) * 10n ** BigInt(this.decimals)) /
      (this.totalSupply + 10n ** BigInt(decimalsOffset))
    );
  }

  private handleDeal(deal: DealEvent) {
    this.preReferrals[deal.owner] = {
      feeRewardRate: deal.feeRewardRate,
      feeRebateRate: deal.feeRebateRate,
      referrer: deal.referral,
    };
  }

  protected handlePoint(point: PointEvent) {
    const diff = this.pointTracker.registerPoint({
      amount: point.amount,
      name: point.name,
      timestamp: point.blockTimestamp,
    });
    const accountsArray = Object.entries(this.accounts);
    accountsArray.forEach((user) => {
      const account = user[1];
      if (this.totalSupply == 0n || !this.totalSupply) {
        throw new Error(
          `Totalsupply is 0, ${point.name} point distribution is not possible at ${point.blockTimestamp}`
        );
      }

      const userPart =
        (Number(account.getBalance()) * diff) / Number(this.totalSupply);
      account.increasePoints(point.name, userPart);
    });
  }

  public pointNames(): string[] {
    return this.pointTracker.pointNames();
  }

  public distributeRebatesAndRewards() {
    const accountsArray = Object.values(this.accounts);
    accountsArray.forEach((account) => {
      const address = account.address;

      const referrer = this.referrals[address]?.referrer;
      const fees = account.getFees();
      const rebate = this.referrals[address]?.feeRebateRate;
      const reward = this.referrals[address]?.feeRewardRate;

      if (account)
        if (rebate) {
          this.accounts[address].increaseCashback(
            (fees * BigInt(rebate)) / BPS_DIVIDER
          );
        }
      if (reward && referrer) {
        const referrerAcc = this.getAndCreateAccount(referrer);
        referrerAcc.increaseCashback((fees * BigInt(reward)) / BPS_DIVIDER);
      }
    });
  }

  public accumulatedSupply(): bigint {
    const accountss = Object.entries(this.accounts);
    const acc = accountss.reduce((acc, curr) => acc + curr[1].getBalance(), 0n);
    return acc;
  }

  public accumulatedFeesSinceFromBlock(): bigint {
    const accountss = Object.entries(this.accounts);
    const acc = accountss.reduce((acc, curr) => acc + curr[1].getFees(), 0n);
    return acc;
  }

  public balance(user: Address): bigint {
    return this.accounts[user].getBalance();
  }

  public totalPointsAmongUsers(name: string): number {
    let accumulated = 0;
    for (const acc of Object.values(this.accounts)) {
      accumulated += acc.getPoints(name);
    }
    return accumulated;
  }

  public lastPointEventValue(name: string): number {
    const dot = this.pointTracker.lastPoint(name);
    if (!dot) return 0;
    return dot.amount;
  }

  public accumulatedBalances(): bigint {
    let tt = 0n;
    for (const [_, acc] of Object.entries(this.accounts)) {
      tt += acc.getBalance();
    }
    return tt;
  }

  public users(): Address[] {
    const _users: Address[] = [];
    for (const [address, _] of Object.entries(this.accounts)) {
      _users.push(address as Address);
    }
    return _users;
  }

  public async processEvents({
    events,
    distributeFeesFromBlock,
    blockEndHook,
  }: ProcessEventsParams) {
    for (let i = 0; i < events.length; i++) {
      const currentBlock: bigint = events[i].blockNumber;
      const nextBlock = events[i + 1] ? events[i + 1].blockNumber : maxUint256;
      this.processEvent({
        event: events[i] as { __typename: string; blockNumber: bigint },
        distributeFeesFromBlock,
      });

      // if we are done with the block, we can call the hook
      if (currentBlock != nextBlock && blockEndHook)
        await blockEndHook(currentBlock);
    }
  }

  public processEvent({ event, distributeFeesFromBlock }: ProcessEventParams) {
    if (event.__typename === "TotalAssetsUpdated") {
      this.handleTotalAssetsUpdated(event as TotalAssetsUpdated);
    } else if (event.__typename === "NewTotalAssetsUpdated") {
      this.handleNewTotalAssetsUpdated();
    } else if (event.__typename === "Deposit") {
      this.handleDeposit(event as Deposit);
    } else if (event.__typename === "DepositRequest") {
      this.depositRequest(event as DepositRequest);
    } else if (event.__typename === "DepositRequestCanceled") {
      this.handleDepositRequestCanceled(event as DepositRequestCanceled);
    } else if (event.__typename === "RedeemRequest") {
      this.redeemRequest(event as RedeemRequest);
    } else if (event.__typename === "SettleDeposit") {
      this.handleSettleDeposit(event as SettleDeposit);
    } else if (event.__typename === "SettleRedeem") {
      this.handleSettleRedeem(event as SettleRedeem);
    } else if (event.__typename === "Transfer") {
      this.handleTransfer(
        event as Transfer,
        BigInt(distributeFeesFromBlock) < event.blockNumber
      );
    } else if (event.__typename === "Referral") {
      this.handleReferral(event as ReferralCustom);
    } else if (event.__typename === "Deal") {
      this.handleDeal(event as any as DealEvent); // TODO: fix any
    } else if (event.__typename === "FeeReceiverUpdated") {
      this.handleFeeReceiverUpdateds(event as FeeReceiverUpdated);
    } else if (event.__typename === "RatesUpdated") {
      this.handleRatesUpdateds(event as RatesUpdated);
    } else if (event.__typename === "Point") {
      this.handlePoint(event as any as PointEvent); // TODO: fix any
    } else {
      throw new Error(`Unknown event ${event.__typename} : ${event}`);
    }
  }

  // DEBUG AND TESTING PURPOSE
  public async testSupply(
    blockNumber: bigint,
    address: Address
  ): Promise<bigint> {
    const acc = this.accumulatedSupply();
    if (this.totalSupply + 100n < acc || this.totalSupply - 100n > acc) {
      console.error({ error: "Error", totalSupply: this.totalSupply, acc });

      console.error(
        "Good value",
        await this.rightTotalSupply(blockNumber, address)
      );
      throw "mismatch in totalsupply";
    } else console.log("Supply is good");
    return acc;
  }

  public getAccounts(): Record<Address, UserAccount> {
    return this.accounts;
  }

  public async balanceOf(
    blockNumber: number,
    address: Address
  ): Promise<bigint> {
    const client = publicClient[1];
    const totalSupp = await client.readContract({
      abi: erc20Abi,
      functionName: "balanceOf",
      address,
      args: [address],
      blockNumber: BigInt(blockNumber),
    });
    return totalSupp;
  }

  public async rightTotalSupply(
    blockNumber: bigint,
    address: Address
  ): Promise<bigint> {
    const client = publicClient[1];
    const totalSupp = await client.readContract({
      abi: erc20Abi,
      functionName: "totalSupply",
      address,
      blockNumber: BigInt(blockNumber),
    });
    return totalSupp;
  }
}
