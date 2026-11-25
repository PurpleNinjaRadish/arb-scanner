package com.arbscanner.mobile.data

data class Opportunity(
    val symbol: String,
    val buyOn: String,
    val sellOn: String,
    val buyPrice: Double,
    val sellPrice: Double,
    val spread: Double,
    val netProfit: Double,
    val netDollar: Double,
    val feePct: Double,
    val minVol: Double?,
    val estimated: Boolean,
    val isViable: Boolean,
    val tradeSize: Double,
)

data class TargetAlert(
    val id: String,
    val ts: Long,
    val isTest: Boolean,
    val read: Boolean,
    val symbol: String,
    val quote: String,
    val pair: String,
    val buyOn: String,
    val sellOn: String,
    val buyPrice: Double,
    val sellPrice: Double,
    val tradeSize: Double,
    val netProfitPct: Double,
    val netDollar: Double,
    val verifiedL2: Boolean,
    val title: String,
    val message: String,
)

data class AlertWatcherStatus(
    val enabled: Boolean,
    val checksCount: Int,
    val lastCheckAt: Long,
    val unreadCount: Int,
    val pair: String,
    val quote: String,
    val minNetPct: Double,
    val minNetDollar: Double,
    val verifyOrderBook: Boolean,
    val ntfyTopic: String,
)

data class HostInfo(
    val id: String,
    val name: String,
    val kind: String,
    val online: Boolean,
    val runningCount: Int,
    val totalCount: Int,
)

data class BotContainer(
    val id: String,
    val name: String,
    val state: String,
    val status: String,
    val configFile: String,
    val paper: Boolean?,
    val cpuPct: Double?,
    val memUsedMb: Int?,
)

data class PaperSimSummary(
    val active: Boolean,
    val running: Boolean,
    val tickCount: Int,
    val filledTrades: Int,
    val decayedSignals: Int,
    val actualProfit: Double,
    val roiPct: Double,
    val signalSurvivalPct: Double?,
    val avgDriftBps: Double?,
)

data class HoldingItem(
    val asset: String,
    val total: Double,
    val free: Double,
    val priceUsd: Double,
    val valueUsd: Double,
    val pct: Double,
)

data class AccountSummary(
    val id: String,
    val source: String,
    val label: String,
    val status: String,
    val error: String?,
    val totalUsd: Double,
    val holdings: List<HoldingItem>,
)

data class TxItem(
    val id: String,
    val ts: Long,
    val source: String,
    val account: String,
    val type: String,
    val side: String,
    val symbol: String,
    val amount: Double,
    val price: Double,
    val valueUsd: Double,
    val feeUsd: Double,
    val pnlUsd: Double?,
)

data class PortfolioSnapshot(
    val totalUsd: Double,
    val liveUsd: Double,
    val paperHummingbotUsd: Double,
    val paperLabUsd: Double,
    val openOrderCount: Int,
    val accounts: List<AccountSummary>,
    val transactions: List<TxItem>,
)

data class L2VerifyResult(
    val symbol: String,
    val quote: String,
    val stillProfitable: Boolean,
    val actualNetDollar: Double,
    val actualNetPct: Double,
    val buyVwap: Double,
    val sellVwap: Double,
    val totalDriftBps: Double,
    val totalProcessingMs: Int,
    val complete: Boolean,
)
