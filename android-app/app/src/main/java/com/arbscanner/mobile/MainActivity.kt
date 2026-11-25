package com.arbscanner.mobile

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountBalanceWallet
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Radar
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.arbscanner.mobile.data.ArbApiClient
import com.arbscanner.mobile.data.PrefsStore
import com.arbscanner.mobile.notifications.AlertForegroundService
import com.arbscanner.mobile.notifications.AlertNotificationHelper
import com.arbscanner.mobile.notifications.AlertPollWorker
import com.arbscanner.mobile.ui.*

private enum class NavTab(val id: String, val label: String, val icon: ImageVector) {
    SCANNER("scanner", "Scan", Icons.Default.Radar),
    ALERTS("alerts", "Alerts", Icons.Default.Notifications),
    BOTS("bots", "Remote", Icons.Default.SmartToy),
    PORTFOLIO("portfolio", "Holdings", Icons.Default.AccountBalanceWallet),
    SETTINGS("settings", "Connect", Icons.Default.Settings),
}

class MainActivity : ComponentActivity() {
    private val notifPermLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { /* handled gracefully */ }

    private var requestedTab = mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        AlertNotificationHelper.ensureChannels(this)
        val prefs = PrefsStore(this)
        val api = ArbApiClient(prefs)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                notifPermLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }

        AlertPollWorker.schedule(this, prefs.bgPollEnabled)
        if (prefs.livePushServiceEnabled) {
            AlertForegroundService.start(this)
        }
        requestedTab.value = intent?.getStringExtra("open_tab")

        setContent {
            ArbScannerTheme {
                ArbScannerMobileApp(api = api, prefs = prefs, openTabHint = requestedTab.value)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        requestedTab.value = intent.getStringExtra("open_tab")
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ArbScannerMobileApp(api: ArbApiClient, prefs: PrefsStore, openTabHint: String?) {
    var activeTab by remember { mutableStateOf(NavTab.SCANNER) }
    var unreadAlerts by remember { mutableIntStateOf(0) }

    LaunchedEffect(openTabHint) {
        if (openTabHint == "alerts") activeTab = NavTab.ALERTS
    }

    Scaffold(
        containerColor = ArbColors.Bg,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = ArbColors.Panel),
                title = {
                    Text(
                        "ARB SCANNER v3",
                        fontWeight = FontWeight.Black,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 16.sp,
                        color = ArbColors.Cyan
                    )
                },
                actions = {
                    PillBadge(activeTab.label.uppercase(), ArbColors.Blue)
                }
            )
        },
        bottomBar = {
            NavigationBar(containerColor = ArbColors.Panel) {
                NavTab.entries.forEach { tab ->
                    NavigationBarItem(
                        selected = activeTab == tab,
                        onClick = { activeTab = tab },
                        icon = {
                            if (tab == NavTab.ALERTS && unreadAlerts > 0) {
                                BadgedBox(badge = { Badge { Text(unreadAlerts.toString()) } }) {
                                    Icon(tab.icon, contentDescription = tab.label)
                                }
                            } else {
                                Icon(tab.icon, contentDescription = tab.label)
                            }
                        },
                        label = { Text(tab.label, fontSize = 10.sp) }
                    )
                }
            }
        }
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when (activeTab) {
                NavTab.SCANNER -> ScannerScreen(api = api, prefs = prefs)
                NavTab.ALERTS -> AlertsScreen(api = api, onUnreadUpdated = { unreadAlerts = it })
                NavTab.BOTS -> RemoteControlScreen(api = api, prefs = prefs)
                NavTab.PORTFOLIO -> PortfolioScreen(api = api, prefs = prefs)
                NavTab.SETTINGS -> SettingsScreen(api = api, prefs = prefs)
            }
        }
    }
}
