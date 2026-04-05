"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useCopy } from "../copy";
import { Check, Heart } from "lucide-react";
import { useUsageLimitStore } from "../stores/usage-limit-store";

export default function FoundingSupporterPage() {
  const copy = useCopy()

  const router = useRouter();
  const [showToast, setShowToast] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<"free" | "founding">("founding");
  const planTier = useUsageLimitStore((state) => state.planTier);
  const isFoundingSupporter = planTier === "FOUNDING_SUPPORTER";

  const handleUpgrade = () => {
    const checkoutUrl = process.env.NEXT_PUBLIC_FOUNDING_CHECKOUT_URL;
    if (checkoutUrl) {
      window.location.href = checkoutUrl;
    } else {
      setShowToast(true);
      setTimeout(() => setShowToast(false), 3000);
    }
  };

  // If already a Founding Supporter, show thank you message
  if (isFoundingSupporter) {
    return (
      <main className="min-h-screen bg-sophia-bg px-4 py-10 md:px-8 lg:px-16">
        <div className="mx-auto max-w-2xl space-y-12">
          <section className="flex flex-col items-center space-y-6 text-center">
            <div className="flex h-24 w-24 items-center justify-center rounded-full bg-gradient-to-br from-sophia-purple to-sophia-glow shadow-lg">
              <Heart className="h-12 w-12 text-white" fill="white" />
            </div>
            
            <div className="space-y-2">
              <h1 className="text-3xl font-bold text-sophia-text md:text-4xl">
                {copy.foundingSupporter.alreadySupporter.title}
              </h1>
              <p className="text-lg text-sophia-text2 leading-relaxed max-w-md">
                {copy.foundingSupporter.alreadySupporter.message}
              </p>
            </div>

            <div className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-sophia-purple to-sophia-glow px-4 py-2 shadow-md">
              <Heart className="h-4 w-4 text-white" fill="white" />
              <span className="text-sm font-semibold text-white">
                {copy.foundingSupporter.badge.label}
              </span>
            </div>

            <button
              type="button"
              onClick={() => router.push("/")}
              className="rounded-3xl bg-sophia-purple px-8 py-4 text-lg font-semibold text-white shadow-soft transition hover:bg-sophia-glow hover:shadow-lg"
            >
              {copy.foundingSupporter.alreadySupporter.backToSophia}
            </button>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-sophia-bg px-4 py-10 md:px-8 lg:px-16">
      <div className="mx-auto max-w-4xl space-y-16">
        {/* Hero Section */}
        <section className="space-y-6 text-center">
          <Link 
            href="/"
            className="mx-auto flex h-20 w-20 items-center justify-center rounded-3xl bg-sophia-purple text-3xl font-semibold text-white shadow-soft transition-all hover:scale-105 hover:shadow-lg"
          >
            {copy.brand.initial}
          </Link>
          <h1 className="text-3xl font-bold text-sophia-text md:text-4xl">
            {copy.foundingSupporter.title}
          </h1>
        </section>

        {/* Hero Copy */}
        <section className="space-y-4 text-center text-sophia-text">
          <p className="text-lg leading-relaxed">{copy.foundingSupporter.hero.p1}</p>
          <p className="text-lg font-semibold text-sophia-purple">{copy.foundingSupporter.hero.p2}</p>
          
          <div className="space-y-2">
            <p className="leading-relaxed">{copy.foundingSupporter.hero.mission1}</p>
            <p className="leading-relaxed">{copy.foundingSupporter.hero.mission2}</p>
          </div>

          <p className="text-lg font-semibold text-sophia-purple">{copy.foundingSupporter.hero.p3}</p>
          <p className="leading-relaxed">{copy.foundingSupporter.hero.p4}</p>

          <p className="font-medium">{copy.foundingSupporter.hero.p5}</p>
          <ul className="mx-auto max-w-2xl space-y-2 text-left">
            <li className="flex items-start gap-2">
              <span className="mt-1 text-sophia-purple">●</span>
              <span>{copy.foundingSupporter.hero.shaping1}</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-1 text-sophia-purple">●</span>
              <span>{copy.foundingSupporter.hero.shaping2}</span>
            </li>
          </ul>

          <p className="font-semibold">{copy.foundingSupporter.hero.p6}</p>
          <p className="leading-relaxed">{copy.foundingSupporter.hero.p7}</p>
          <p className="leading-relaxed">{copy.foundingSupporter.hero.p8}</p>
          <p className="leading-relaxed">{copy.foundingSupporter.hero.p9}</p>
          
          <blockquote className="mx-auto max-w-xl rounded-2xl bg-sophia-reply p-6 text-lg font-medium italic text-sophia-text">
            {copy.foundingSupporter.hero.quote}
          </blockquote>

          <p className="text-lg font-medium">{copy.foundingSupporter.hero.p10}</p>
        </section>

        {/* What You're Supporting */}
        <section className="space-y-6">
          <h2 className="text-center text-2xl font-bold text-sophia-text">
            {copy.foundingSupporter.supporting.title}
          </h2>
          <div className="grid gap-6 md:grid-cols-3">
            <div className="rounded-3xl bg-sophia-surface p-6 shadow-soft">
              <h3 className="mb-3 text-lg font-semibold text-sophia-purple">
                {copy.foundingSupporter.supporting.card1Title}
              </h3>
              <p className="text-sm leading-relaxed text-sophia-text">
                {copy.foundingSupporter.supporting.card1Body}
              </p>
            </div>
            <div className="rounded-3xl bg-sophia-surface p-6 shadow-soft">
              <h3 className="mb-3 text-lg font-semibold text-sophia-purple">
                {copy.foundingSupporter.supporting.card2Title}
              </h3>
              <p className="text-sm leading-relaxed text-sophia-text">
                {copy.foundingSupporter.supporting.card2Body}
              </p>
            </div>
            <div className="rounded-3xl bg-sophia-surface p-6 shadow-soft">
              <h3 className="mb-3 text-lg font-semibold text-sophia-purple">
                {copy.foundingSupporter.supporting.card3Title}
              </h3>
              <p className="text-sm leading-relaxed text-sophia-text">
                {copy.foundingSupporter.supporting.card3Body}
              </p>
            </div>
          </div>
        </section>

        {/* Plans Comparison */}
        <section className="space-y-6">
          <h2 className="text-center text-2xl font-bold text-sophia-text">
            {copy.foundingSupporter.plans.title}
          </h2>
          
          {/* Plan Toggle */}
          <div className="mx-auto flex max-w-md items-center justify-center gap-2 rounded-2xl bg-sophia-surface p-1 shadow-soft">
            <button
              type="button"
              onClick={() => setSelectedPlan("free")}
              className={`flex-1 rounded-xl px-4 py-2 text-sm font-semibold transition-all ${
                selectedPlan === "free"
                  ? "bg-sophia-purple text-white shadow-md"
                  : "text-sophia-text2 hover:text-sophia-text"
              }`}
            >
              {copy.foundingSupporter.plans.free.title}
            </button>
            <button
              type="button"
              onClick={() => setSelectedPlan("founding")}
              className={`flex-1 rounded-xl px-4 py-2 text-sm font-semibold transition-all ${
                selectedPlan === "founding"
                  ? "bg-sophia-purple text-white shadow-md"
                  : "text-sophia-text2 hover:text-sophia-text"
              }`}
            >
              {copy.foundingSupporter.plans.founding.title}
            </button>
          </div>

          {/* Plan Cards */}
          <div className="grid gap-6 sm:grid-cols-2">
            {/* Free Plan */}
            <div
              onClick={() => setSelectedPlan("free")}
              className={`cursor-pointer rounded-3xl border-2 p-5 sm:p-6 shadow-soft transition-all min-w-0 ${
                selectedPlan === "free"
                  ? "border-sophia-purple bg-sophia-purple/5 ring-2 ring-sophia-purple/30"
                  : "border-sophia-surface-border bg-sophia-surface"
              }`}
            >
              <h3 className="mb-4 text-xl font-bold text-sophia-text">
                {copy.foundingSupporter.plans.free.title}
              </h3>
              <ul className="space-y-3">
                {copy.foundingSupporter.plans.free.features.map((feature, idx) => (
                  <li key={idx} className="flex items-start gap-3 min-w-0">
                    <Check className="mt-0.5 h-5 w-5 flex-shrink-0 text-sophia-text2" />
                    <span className="text-sm text-sophia-text break-words">{feature}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Founding Supporter Plan */}
            <div
              onClick={() => setSelectedPlan("founding")}
              className={`relative cursor-pointer rounded-3xl border-2 p-5 sm:p-6 shadow-soft transition-all min-w-0 ${
                selectedPlan === "founding"
                  ? "border-sophia-purple bg-sophia-purple/5 ring-2 ring-sophia-purple/30"
                  : "border-sophia-surface-border bg-sophia-surface"
              }`}
            >
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 max-w-[calc(100%-2rem)] truncate rounded-full bg-sophia-purple px-4 py-1 text-center text-xs font-semibold text-white">
                {copy.foundingSupporter.plans.founding.badge}
              </div>
              <h3 className="mb-2 text-xl font-bold text-sophia-purple">
                {copy.foundingSupporter.plans.founding.title}
              </h3>
              <p className="mb-4 text-sm font-medium text-sophia-text break-words">
                {copy.foundingSupporter.plans.founding.price}
              </p>
              <ul className="mb-6 space-y-3">
                {copy.foundingSupporter.plans.founding.features.map((feature, idx) => (
                  <li key={idx} className="flex items-start gap-3 min-w-0">
                    <Check className="mt-0.5 h-5 w-5 flex-shrink-0 text-sophia-purple" />
                    <span className="text-sm text-sophia-text break-words">{feature}</span>
                  </li>
                ))}
              </ul>
              <p className="text-xs italic text-sophia-text2">
                {copy.foundingSupporter.plans.founding.badgeSubtext}
              </p>
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="flex justify-center pb-10">
          <button
            type="button"
            onClick={handleUpgrade}
            disabled={selectedPlan === "free"}
            className={`rounded-3xl px-8 py-4 text-lg font-semibold shadow-soft transition ${
              selectedPlan === "free"
                ? "cursor-not-allowed bg-sophia-text2/30 text-sophia-text2"
                : "bg-sophia-purple text-white hover:bg-sophia-glow hover:shadow-lg"
            }`}
          >
            {copy.foundingSupporter.cta}
          </button>
        </section>
      </div>

      {/* Toast */}
      {showToast && (
        <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-2xl bg-sophia-purple px-6 py-3 text-sm font-medium text-white shadow-soft">
          {copy.foundingSupporter.ctaNotLive}
        </div>
      )}
    </main>
  );
}

