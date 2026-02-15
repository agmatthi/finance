"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Link2, X, ExternalLink, ArrowRight } from "lucide-react";
import Image from "next/image";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

const DISMISSED_KEY = "portfolio-connector-dismissed";

const connectors = [
  {
    id: "robinhood",
    name: "Robinhood",
    icon: "/brokerage-robinhood.png",
    description: "Import your Robinhood portfolio holdings, transactions, and performance data for personalized financial analysis.",
  },
  {
    id: "schwab",
    name: "Charles Schwab",
    icon: "/brokerage-schwab.png",
    description: "Connect your Schwab account to analyze your portfolio holdings, asset allocation, and investment performance.",
  },
  {
    id: "fidelity",
    name: "Fidelity",
    icon: "/brokerage-fidelity.png",
    description: "Import your Fidelity portfolio data including 401(k), IRA, and brokerage holdings for comprehensive analysis.",
  },
  {
    id: "etrade",
    name: "E*TRADE",
    icon: "/brokerage-etrade.png",
    description: "Sync your E*TRADE portfolio to get insights on your stock, options, and ETF positions.",
  },
  {
    id: "webull",
    name: "Webull",
    icon: "/brokerage-webull.png",
    description: "Connect your Webull account to analyze your trades, positions, and overall portfolio performance.",
  },
  {
    id: "ibkr",
    name: "Interactive Brokers",
    icon: "/brokerage-ibkr.png",
    description: "Import your IBKR portfolio data including multi-currency positions, margin details, and trading history.",
  },
];

export function PortfolioConnector() {
  const [dismissed, setDismissed] = useState(true);
  const [showDialog, setShowDialog] = useState(false);
  const [selectedConnector, setSelectedConnector] = useState<typeof connectors[0] | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const stored = localStorage.getItem(DISMISSED_KEY);
    if (stored !== "true") {
      setDismissed(false);
    }
  }, []);

  const handleDismiss = () => {
    setDismissed(true);
    localStorage.setItem(DISMISSED_KEY, "true");
  };

  const handleConnectorClick = (connector: typeof connectors[0]) => {
    setSelectedConnector(connector);
    setShowDialog(true);
  };

  const handleConnect = () => {
    setConnecting(true);
    setTimeout(() => {
      setConnecting(false);
      setShowDialog(false);
    }, 2000);
  };

  if (!mounted || dismissed) return null;

  return (
    <>
      <AnimatePresence>
        {!dismissed && (
          <motion.div
            className="flex items-center gap-2 px-4 py-2 border-t border-border"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
          >
            <Link2 className="h-3.5 w-3.5 text-muted-foreground/70 flex-shrink-0" />
            <span className="text-xs text-muted-foreground/70 whitespace-nowrap">
              Connect your portfolio
            </span>

            <div className="flex-1" />

            <div className="flex items-center gap-1.5">
              {connectors.map((connector) => (
                <button
                  key={connector.id}
                  onClick={() => handleConnectorClick(connector)}
                  className="relative h-5 w-5 rounded-full overflow-hidden bg-muted border border-border/50 hover:scale-110 hover:border-muted-foreground/40 transition-all focus:outline-none"
                  title={`Connect ${connector.name}`}
                >
                  <Image
                    src={connector.icon}
                    alt={connector.name}
                    width={20}
                    height={20}
                    className="object-cover w-full h-full"
                  />
                </button>
              ))}
            </div>

            <button
              onClick={handleDismiss}
              className="text-muted-foreground/50 hover:text-foreground transition-colors flex-shrink-0"
              title="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-3 text-lg font-semibold">
              {selectedConnector && (
                <div className="relative h-8 w-8 rounded-full overflow-hidden border border-border">
                  <Image
                    src={selectedConnector.icon}
                    alt={selectedConnector.name}
                    fill
                    className="object-cover"
                  />
                </div>
              )}
              Connect {selectedConnector?.name}
            </DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground mt-2">
              {selectedConnector?.description}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 mt-4">
            <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
              <h4 className="text-sm font-medium text-foreground">What you&apos;ll get:</h4>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li className="flex items-start gap-2">
                  <ArrowRight className="h-3.5 w-3.5 mt-0.5 text-primary flex-shrink-0" />
                  Portfolio holdings analysis and insights
                </li>
                <li className="flex items-start gap-2">
                  <ArrowRight className="h-3.5 w-3.5 mt-0.5 text-primary flex-shrink-0" />
                  Personalized financial recommendations
                </li>
                <li className="flex items-start gap-2">
                  <ArrowRight className="h-3.5 w-3.5 mt-0.5 text-primary flex-shrink-0" />
                  Transaction history and performance tracking
                </li>
              </ul>
            </div>

            <div className="p-3 bg-primary/5 border border-primary/20 rounded-lg">
              <p className="text-xs text-muted-foreground">
                Your data is read-only and never shared. Connection is secured via OAuth 2.0.
              </p>
            </div>

            <Button
              onClick={handleConnect}
              disabled={connecting}
              className="w-full rounded-xl h-11 text-sm font-medium"
            >
              {connecting ? (
                <span className="flex items-center gap-2">
                  <span className="h-4 w-4 border-2 border-background/30 border-t-background rounded-full animate-spin" />
                  Connecting...
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <ExternalLink className="h-4 w-4" />
                  Connect with {selectedConnector?.name}
                </span>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
