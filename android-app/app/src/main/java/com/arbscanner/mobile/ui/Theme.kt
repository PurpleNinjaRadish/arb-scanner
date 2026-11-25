package com.arbscanner.mobile.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.util.Locale

object ArbColors {
    val Bg = Color(0xFF050810)
    val Panel = Color(0xFF0A101E)
    val PanelAlt = Color(0xFF10192E)
    val Border = Color(0xFF1B2E4B)
    val Text = Color(0xFFD6E3F4)
    val Muted = Color(0xFF7B93B4)
    val Blue = Color(0xFF3B8DFF)
    val Green = Color(0xFF00E68A)
    val Cyan = Color(0xFF22D3EE)
    val Yellow = Color(0xFFFFCC33)
    val Red = Color(0xFFFF4D64)
    val Purple = Color(0xFFA78BFA)
}

private val DarkScheme = darkColorScheme(
    primary = ArbColors.Blue,
    secondary = ArbColors.Green,
    tertiary = ArbColors.Cyan,
    background = ArbColors.Bg,
    surface = ArbColors.Panel,
    surfaceVariant = ArbColors.PanelAlt,
    onBackground = ArbColors.Text,
    onSurface = ArbColors.Text,
    error = ArbColors.Red,
)

@Composable
fun ArbScannerTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = DarkScheme, content = content)
}

@Composable
fun PillBadge(text: String, color: Color) {
    Surface(
        color = color.copy(alpha = 0.16f),
        border = BorderStroke(1.dp, color.copy(alpha = 0.45f)),
        shape = RoundedCornerShape(6.dp),
    ) {
        Text(
            text = text,
            color = color,
            fontSize = 10.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
        )
    }
}

fun fmtUsd(v: Double, decimals: Int = 2): String {
    val sign = if (v < 0) "-" else ""
    return String.format(Locale.US, "%s$%,.${decimals}f", sign, kotlin.math.abs(v))
}

fun fmtPrice(v: Double): String = when {
    v <= 0 -> "—"
    v < 0.01 -> String.format(Locale.US, "$%.6f", v)
    v < 1.0 -> String.format(Locale.US, "$%.4f", v)
    v < 1000.0 -> String.format(Locale.US, "$%.3f", v)
    else -> String.format(Locale.US, "$%,.2f", v)
}
