import type { Session } from "@supabase/supabase-js";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ensureProfile, linkDrive } from "../lib/api";
import { friendlyAuthError } from "../lib/errors";
import { googleSignOut, signInForDrive, signInForIdentity } from "../lib/googleAuth";
import { supabase } from "../lib/supabase";
import type { Profile } from "../lib/types";

type AuthContextValue = {
  ready: boolean;
  session: Session | null;
  profile: Profile | null;
  busy: boolean;
  error: string | null;
  signIn: () => Promise<void>;
  connectDrive: () => Promise<void>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  clearError: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshProfile = useCallback(async () => {
    const next = await ensureProfile();
    setProfile(next);
  }, []);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setReady(true);
    });
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      if (!next) setProfile(null);
    });
    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      refreshProfile().catch((reason: unknown) => {
        if (!cancelled) setError(friendlyAuthError(reason));
      });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [session, refreshProfile]);

  const signIn = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const { idToken } = await signInForIdentity();
      const { error: signInError } = await supabase.auth.signInWithIdToken({
        provider: "google",
        token: idToken,
      });
      if (signInError) throw signInError;
    } catch (reason) {
      setError(friendlyAuthError(reason));
    } finally {
      setBusy(false);
    }
  }, []);

  const connectDrive = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const { serverAuthCode } = await signInForDrive();
      await linkDrive(serverAuthCode);
      await refreshProfile();
    } catch (reason) {
      setError(friendlyAuthError(reason));
      throw reason;
    } finally {
      setBusy(false);
    }
  }, [refreshProfile]);

  const signOut = useCallback(async () => {
    setError(null);
    await supabase.auth.signOut();
    await googleSignOut();
    setProfile(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      ready,
      session,
      profile,
      busy,
      error,
      signIn,
      connectDrive,
      signOut,
      refreshProfile,
      clearError: () => setError(null),
    }),
    [ready, session, profile, busy, error, signIn, connectDrive, signOut, refreshProfile],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
