'use client';

import { useState, useEffect } from 'react';
import { useAuthStore } from '@/lib/stores/use-auth-store';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { track } from '@vercel/analytics';

interface AuthModalProps {
  open: boolean;
  onClose: () => void;
  onSignUpSuccess?: (message: string) => void;
}

export function AuthModal({ open, onClose, onSignUpSuccess }: AuthModalProps) {
  const signInWithValyu = useAuthStore((state) => state.signInWithValyu);
  const authLoading = useAuthStore((state) => state.loading);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      track('Auth Modal Shown', {
        source: 'prompt_submit',
      });
    }
  }, [open]);

  const handleSignIn = async () => {
    setLoading(true);
    setError(null);

    track('Sign In Clicked', {
      step: 'initiate',
    });

    try {
      const { error } = await signInWithValyu();
      if (error) {
        setError(error.message || 'Failed to initiate sign in');
        setLoading(false);
        track('Sign In Error', {
          step: 'initiate',
          error: error.message || 'Failed to initiate sign in',
        });
      }
    } catch (err) {
      setError('An unexpected error occurred');
      setLoading(false);
      track('Sign In Error', {
        step: 'initiate',
        error: 'unexpected_error',
      });
    }
  };

  const isLoading = loading || authLoading;

  const handleClose = () => {
    track('Auth Modal Dismissed', {
      had_error: !!error,
    });
    setError(null);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[450px]">
        <DialogHeader>
          <DialogTitle className="text-center text-xl">Sign in to OpenTrade</DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-4">
          <p className="text-center text-sm text-muted-foreground leading-relaxed">
            Sign in to access real-time financial data across markets, SEC filings, and research.
          </p>

          {error && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-center">
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            </div>
          )}

          <Button
            onClick={handleSignIn}
            disabled={isLoading}
            className="w-full h-12 bg-foreground hover:bg-foreground/80 text-background font-medium"
          >
            {isLoading ? (
              <span className="flex items-center gap-2">
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Connecting...
              </span>
            ) : (
              <span>Sign in</span>
            )}
          </Button>

          <p className="text-center text-xs text-muted-foreground">
            Don&apos;t have an account? You can create one during sign-in.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
