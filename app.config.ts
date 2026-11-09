import type { ConfigContext, ExpoConfig } from "expo/config";

const supabaseUrl =
  process.env.EXPO_PUBLIC_SUPABASE_URL ?? "https://rsmxyisnwluqashngmht.supabase.co";
const supabaseAnonKey =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJzbXh5aXNud2x1cWFzaG5nbWh0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQyMjg5MjIsImV4cCI6MjEwOTgwNDkyMn0.xf6Oz2RxNMfbXl27Cjd3uaBg2U1LRoIUlLuNC3ma-_M";

const googleWebClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? "";
const googleIosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? "";
const googleAndroidClientId = process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID ?? "";

function iosUrlScheme(): string {
  if (process.env.EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME) {
    return process.env.EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME;
  }
  const prefix = googleIosClientId.split(".apps.googleusercontent.com")[0];
  if (prefix && prefix !== googleIosClientId) {
    return `com.googleusercontent.apps.${prefix}`;
  }
  return "com.googleusercontent.apps.placeholder";
}

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "Go2",
  slug: "go2",
  scheme: "go2",
  version: "1.0.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "light",
  ios: {
    supportsTablet: true,
    bundleIdentifier: "com.go2.photos",
    infoPlist: {
      NSCameraUsageDescription:
        "Go2 uses the camera to take photos for a room and to scan a room QR code.",
    },
  },
  android: {
    package: "com.go2.photos",
    predictiveBackGestureEnabled: false,
    adaptiveIcon: {
      backgroundColor: "#F4EFE6",
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
  },
  web: {
    favicon: "./assets/favicon.png",
  },
  plugins: [
    "expo-router",
    "expo-dev-client",
    [
      "expo-camera",
      {
        cameraPermission: "Allow Go2 to use the camera to take photos and scan room QR codes.",
        barcodeScannerEnabled: true,
      },
    ],
    [
      "@react-native-google-signin/google-signin",
      {
        iosUrlScheme: iosUrlScheme(),
      },
    ],
  ],
  experiments: {
    typedRoutes: false,
  },
  extra: {
    supabaseUrl,
    supabaseAnonKey,
    googleWebClientId,
    googleIosClientId,
    googleAndroidClientId,
    eas: {
      projectId: process.env.EAS_PROJECT_ID ?? "",
    },
  },
});
