plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.arbscanner.mobile"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.arbscanner.mobile"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "3.0.0"
    }

    // Fixed signing key (from GitHub secrets in CI) so every new APK installs as an
    // update over the previous one. Local builds without these env vars fall back
    // to the standard Android debug key.
    val keystorePath = System.getenv("ANDROID_KEYSTORE_FILE")
    val hasFixedKey = !keystorePath.isNullOrBlank() && file(keystorePath).exists()
    signingConfigs {
        if (hasFixedKey) {
            create("fixed") {
                storeFile = file(keystorePath!!)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        debug {
            if (hasFixedKey) signingConfig = signingConfigs.getByName("fixed")
        }
        release {
            if (hasFixedKey) signingConfig = signingConfigs.getByName("fixed")
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.10.01")
    implementation(composeBom)
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")

    // Networking + Coroutines + Background Push Polling
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("androidx.work:work-runtime-ktx:2.10.0")

    debugImplementation("androidx.compose.ui:ui-tooling")
}
