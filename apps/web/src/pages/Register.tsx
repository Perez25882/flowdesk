import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Store, User, Phone, ArrowRight, Loader2, CheckCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface RegisterFormData {
  ownerName: string;
  businessName: string;
  phone: string;
}

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('0')) return `233${digits.slice(1)}`;
  if (digits.startsWith('233')) return digits;
  return `233${digits}`;
}

async function registerBusiness(data: RegisterFormData): Promise<{ id: string; trialEndsAt: string }> {
  const res = await fetch('/api/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Registration failed' }));
    throw new Error(err.error ?? 'Registration failed');
  }
  const payload = await res.json();
  return payload.data;
}

function FloatingOrb({ size, x, y, delay, color }: { size: number; x: string; y: string; delay: number; color: string }): React.JSX.Element {
  return (
    <motion.div
      animate={{ y: [0, -20, 0], opacity: [0.15, 0.3, 0.15] }}
      transition={{ duration: 8, delay, repeat: Infinity, ease: 'easeInOut' }}
      className="pointer-events-none absolute rounded-full blur-3xl"
      style={{ width: size, height: size, left: x, top: y, background: color }}
    />
  );
}

export default function RegisterPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [form, setForm] = useState<RegisterFormData>({ ownerName: '', businessName: '', phone: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleChange = (field: keyof RegisterFormData, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setError(null);
  };

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!form.ownerName.trim() || !form.businessName.trim() || !form.phone.trim()) {
        setError('Fill in all fields');
        return;
      }
      const normalized = normalizePhone(form.phone);
      if (normalized.length < 12) {
        setError('That does not look like a valid Ghana number');
        return;
      }

      setLoading(true);
      try {
        await registerBusiness({
          ownerName: form.ownerName.trim(),
          businessName: form.businessName.trim(),
          phone: normalized,
        });
        setSuccess(true);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
      } finally {
        setLoading(false);
      }
    },
    [form],
  );

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#0f0f0f] p-4">
      <FloatingOrb size={300} x="-5%" y="-10%" delay={0} color="rgba(61,107,82,0.4)" />
      <FloatingOrb size={250} x="70%" y="60%" delay={2} color="rgba(37,211,102,0.15)" />
      <FloatingOrb size={200} x="20%" y="70%" delay={1} color="rgba(61,107,82,0.25)" />

      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
        className="relative z-10 w-full max-w-sm"
      >
        <div className="rounded-2xl border border-[#2a2a2a] bg-[#161616]/70 p-8 backdrop-blur-xl shadow-2xl">
          <AnimatePresence mode="wait">
            {success ? (
              <motion.div
                key="success"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ duration: 0.4 }}
                className="flex flex-col items-center gap-4 text-center"
              >
                <motion.div
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: 'spring', stiffness: 200, damping: 15, delay: 0.1 }}
                  className="flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-[#3d6b52]/20 to-[#4d8a68]/10 border border-[#2a2a2a]"
                >
                  <CheckCircle className="h-8 w-8 text-[#22c55e]" />
                </motion.div>
                <div>
                  <h2 className="text-2xl font-semibold text-[#f0f0f0]">You are all set</h2>
                  <p className="mt-2 text-sm text-[#888]">
                    Your account is ready. Log in with your phone number to get started.
                  </p>
                </div>
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => navigate('/login')}
                  className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#3d6b52] to-[#4d8a68] py-2.5 text-sm font-semibold text-white transition-all hover:shadow-[0_0_20px_rgba(61,107,82,0.3)]"
                >
                  Log in <ArrowRight className="h-4 w-4" />
                </motion.button>
              </motion.div>
            ) : (
              <motion.div
                key="form"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <div className="mb-8 flex flex-col items-center gap-3">
                  <motion.div
                    initial={{ scale: 0.8 }}
                    animate={{ scale: 1 }}
                    transition={{ duration: 0.5 }}
                    className="flex h-14 w-14 items-center justify-center rounded-2xl border border-[#2a2a2a] bg-gradient-to-br from-[#3d6b52]/20 to-[#4d8a68]/10 backdrop-blur-sm"
                  >
                    <Store className="h-7 w-7 text-[#4d8a68]" />
                  </motion.div>
                  <h1 className="text-2xl font-semibold text-[#f0f0f0]">Set up your business</h1>
                  <p className="text-sm text-[#888]">14-day free trial. No card needed.</p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-[#f0f0f0]">Your name</label>
                    <div className="relative">
                      <User className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#555]" />
                      <input
                        type="text"
                        value={form.ownerName}
                        onChange={(e) => handleChange('ownerName', e.target.value)}
                        placeholder="Ama Mensah"
                        className="w-full rounded-xl border border-[#2a2a2a] bg-[#0f0f0f]/60 py-2.5 pl-10 pr-4 text-sm text-[#f0f0f0] placeholder:text-[#555] focus:border-[#3d6b52] focus:outline-none transition-colors"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-[#f0f0f0]">Business name</label>
                    <div className="relative">
                      <Store className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#555]" />
                      <input
                        type="text"
                        value={form.businessName}
                        onChange={(e) => handleChange('businessName', e.target.value)}
                        placeholder="Ama's Grocery"
                        className="w-full rounded-xl border border-[#2a2a2a] bg-[#0f0f0f]/60 py-2.5 pl-10 pr-4 text-sm text-[#f0f0f0] placeholder:text-[#555] focus:border-[#3d6b52] focus:outline-none transition-colors"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="mb-1.5 block text-sm font-medium text-[#f0f0f0]">WhatsApp number</label>
                    <div className="relative">
                      <Phone className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#555]" />
                      <input
                        type="tel"
                        value={form.phone}
                        onChange={(e) => handleChange('phone', e.target.value)}
                        placeholder="0244 123 456"
                        className="w-full rounded-xl border border-[#2a2a2a] bg-[#0f0f0f]/60 py-2.5 pl-10 pr-4 text-sm text-[#f0f0f0] placeholder:text-[#555] focus:border-[#3d6b52] focus:outline-none transition-colors"
                      />
                    </div>
                    <p className="mt-1.5 text-xs text-[#555]">
                      The number connected to your WhatsApp Business account
                    </p>
                  </div>

                  {error && (
                    <motion.p
                      initial={{ opacity: 0, y: -10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="text-sm text-[#ef4444]"
                    >
                      {error}
                    </motion.p>
                  )}

                  <motion.button
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    type="submit"
                    disabled={loading}
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#3d6b52] to-[#4d8a68] py-2.5 text-sm font-semibold text-white transition-all hover:shadow-[0_0_20px_rgba(61,107,82,0.3)] disabled:opacity-50 disabled:hover:shadow-none"
                  >
                    {loading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        Create account <ArrowRight className="h-4 w-4" />
                      </>
                    )}
                  </motion.button>
                </form>

                <div className="mt-6 border-t border-[#2a2a2a] pt-6">
                  <p className="text-center text-sm text-[#555]">
                    Already have an account?{' '}
                    <button
                      onClick={() => navigate('/login')}
                      className="font-medium text-[#4d8a68] transition-colors hover:text-[#3d6b52]"
                    >
                      Log in
                    </button>
                  </p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}
