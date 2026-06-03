import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Phone, Lock, ArrowRight, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { useRequestOTP, useVerifyOTP, isAuthenticated } from '@/hooks/useAuth';

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('0')) return `233${digits.slice(1)}`;
  if (digits.startsWith('233')) return digits;
  return `233${digits}`;
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

export default function LoginPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [countdown, setCountdown] = useState(300);

  const requestOTP = useRequestOTP();
  const verifyOTP = useVerifyOTP();

  useEffect(() => {
    if (isAuthenticated()) {
      navigate('/dashboard', { replace: true });
    }
  }, [navigate]);

  useEffect(() => {
    if (step !== 'otp' || countdown <= 0) return undefined;
    const t = setInterval(() => setCountdown((c) => c - 1), 1000);
    return () => clearInterval(t);
  }, [step, countdown]);

  const handleRequestOTP = useCallback(() => {
    const formatted = normalizePhone(phone);
    if (formatted.length < 12) return;
    requestOTP.mutate(formatted, {
      onSuccess: () => {
        setStep('otp');
        setCountdown(300);
      },
    });
  }, [phone, requestOTP]);

  const handleVerify = useCallback(() => {
    const formatted = normalizePhone(phone);
    verifyOTP.mutate(
      { phone: formatted, otp },
      {
        onSuccess: () => navigate('/dashboard', { replace: true }),
      },
    );
  }, [phone, otp, verifyOTP, navigate]);

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
          <div className="mb-8 flex flex-col items-center gap-3">
            <motion.div
              initial={{ scale: 0.8 }}
              animate={{ scale: 1 }}
              transition={{ duration: 0.5 }}
              className="flex h-14 w-14 items-center justify-center rounded-2xl border border-[#2a2a2a] bg-gradient-to-br from-[#3d6b52]/20 to-[#4d8a68]/10 backdrop-blur-sm"
            >
              <svg width="28" height="28" viewBox="0 0 360 362" fill="none">
                <path
                  fill="#25D366"
                  d="M307.546 52.566C273.709 18.684 228.706.017 180.756 0 81.951 0 1.538 80.404 1.504 179.235c-.017 31.594 8.242 62.432 23.928 89.609L0 361.736l95.024-24.925c26.179 14.285 55.659 21.805 85.655 21.814h.077c98.788 0 179.21-80.413 179.244-179.244.017-47.898-18.608-92.926-52.454-126.807v-.008Zm-126.79 275.788h-.06c-26.73-.008-52.952-7.194-75.831-20.765l-5.44-3.231-56.391 14.791 15.05-54.981-3.542-5.638c-14.912-23.721-22.793-51.139-22.776-79.286.035-82.14 66.867-148.973 149.051-148.973 39.793.017 77.198 15.53 105.328 43.695 28.131 28.157 43.61 65.596 43.593 105.398-.035 82.149-66.867 148.982-148.982 148.982v.008Z"
                />
              </svg>
            </motion.div>
            <h1 className="text-2xl font-semibold text-[#f0f0f0]">Log in to Flowdesk</h1>
            <p className="text-sm text-[#888]">We will send a code to your WhatsApp</p>
          </div>

          <AnimatePresence mode="wait">
            {step === 'phone' && (
              <motion.div
                key="phone"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                transition={{ duration: 0.3 }}
                className="space-y-4"
              >
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-[#f0f0f0]">
                    Phone Number
                  </label>
                  <div className="relative">
                    <Phone className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#555]" />
                    <input
                      type="tel"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="0244 123 456"
                      className="w-full rounded-xl border border-[#2a2a2a] bg-[#0f0f0f]/60 py-2.5 pl-10 pr-4 text-sm text-[#f0f0f0] placeholder:text-[#555] focus:border-[#3d6b52] focus:outline-none transition-colors"
                    />
                  </div>
                  <p className="mt-1.5 text-xs text-[#555]">
                    Use the number linked to your WhatsApp Business
                  </p>
                </div>

                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={handleRequestOTP}
                  disabled={requestOTP.isPending || phone.replace(/\D/g, '').length < 9}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#3d6b52] to-[#4d8a68] py-2.5 text-sm font-semibold text-white transition-all hover:shadow-[0_0_20px_rgba(61,107,82,0.3)] disabled:opacity-50 disabled:hover:shadow-none"
                >
                  {requestOTP.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <>
                      Send code <ArrowRight className="h-4 w-4" />
                    </>
                  )}
                </motion.button>

                {requestOTP.isError && (
                  <motion.p
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="text-center text-sm text-[#ef4444]"
                  >
                    {requestOTP.error instanceof Error ? requestOTP.error.message : 'Could not send code. Try again.'}
                  </motion.p>
                )}
              </motion.div>
            )}

            {step === 'otp' && (
              <motion.div
                key="otp"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                transition={{ duration: 0.3 }}
                className="space-y-4"
              >
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-[#f0f0f0]">
                    Enter the code
                  </label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#555]" />
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      value={otp}
                      onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                      placeholder="123456"
                      className="w-full rounded-xl border border-[#2a2a2a] bg-[#0f0f0f]/60 py-2.5 pl-10 pr-4 text-sm tracking-[0.5em] text-[#f0f0f0] placeholder:tracking-normal placeholder:text-[#555] focus:border-[#3d6b52] focus:outline-none transition-colors"
                    />
                  </div>
                  <p className="mt-1.5 text-xs text-[#555]">
                    Code expires in {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, '0')}
                  </p>
                </div>

                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={handleVerify}
                  disabled={verifyOTP.isPending || otp.length !== 6}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#3d6b52] to-[#4d8a68] py-2.5 text-sm font-semibold text-white transition-all hover:shadow-[0_0_20px_rgba(61,107,82,0.3)] disabled:opacity-50 disabled:hover:shadow-none"
                >
                  {verifyOTP.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <>Log in</>
                  )}
                </motion.button>

                <button
                  onClick={() => setStep('phone')}
                  className="w-full text-center text-sm text-[#555] transition-colors hover:text-[#888]"
                >
                  Back to phone number
                </button>

                {verifyOTP.isError && (
                  <motion.p
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="text-center text-sm text-[#ef4444]"
                  >
                    {verifyOTP.error instanceof Error ? verifyOTP.error.message : 'Code did not match. Try again.'}
                  </motion.p>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          <div className="mt-6 border-t border-[#2a2a2a] pt-6">
            <p className="text-center text-sm text-[#555]">
              New here?{' '}
              <button
                onClick={() => navigate('/register')}
                className="font-medium text-[#4d8a68] transition-colors hover:text-[#3d6b52]"
              >
                Create an account
              </button>
            </p>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
