plugins {
    id("com.android.application")
}

// version comes from the release tag in CI (-Pflowcarbon.version=0.1.2); versionCode = major·10000 + minor·100 + patch
val appVersion = (findProperty("flowcarbon.version") as String?) ?: "0.0.0"
val (major, minor, patch) = appVersion.split(".").map { it.toInt() }
val keystore: String? = System.getenv("FLOWCARBON_KEYSTORE")

android {
    namespace = "org.veritybench.flowcarbon"
    compileSdk = 36

    defaultConfig {
        applicationId = "org.veritybench.flowcarbon"
        minSdk = 26
        targetSdk = 36
        versionCode = major * 10_000 + minor * 100 + patch
        versionName = appVersion
    }

    signingConfigs {
        create("release") {
            if (keystore != null) {
                storeFile = file(keystore)
                storePassword = System.getenv("FLOWCARBON_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("FLOWCARBON_KEY_ALIAS")
                keyPassword = System.getenv("FLOWCARBON_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // without a key (forks, local builds) the release APK stays unsigned
            if (keystore != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        abortOnError = true
        checkReleaseBuilds = true
    }
}
