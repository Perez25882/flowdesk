import { useNavigate } from 'react-router-dom';
import {
  MessageSquare, ShoppingCart, Wallet, BarChart3, Users, Zap,
  Check, ArrowRight, Menu, X, TrendingUp, Sparkles,
} from 'lucide-react';
import { useState, useEffect } from 'react';
import { motion, useScroll, useTransform } from 'framer-motion';

const easeOutExpo = [0.16, 1, 0.3, 1] as const;

function WhatsAppBubble({ size, x, y, delay, duration }: { size: number; x: string; y: string; delay: number; duration: number }): React.JSX.Element {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.5 }}
      animate={{ opacity: [0.15, 0.35, 0.15], y: [0, -30, 0], scale: [1, 1.1, 1], rotate: [0, 5, -5, 0] }}
      transition={{ duration, delay, repeat: Infinity, ease: 'easeInOut' }}
      className="pointer-events-none absolute"
      style={{ left: x, top: y }}
    >
      <div
        className="flex items-center justify-center rounded-[28%] border border-white/[0.08] bg-white/[0.03] backdrop-blur-2xl shadow-2xl"
        style={{ width: size, height: size }}
      >
        <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 360 362" fill="none">
          <path
            fill="#25D366"
            fillOpacity="0.6"
            fillRule="evenodd"
            clipRule="evenodd"
            d="M307.546 52.566C273.709 18.684 228.706.017 180.756 0 81.951 0 1.538 80.404 1.504 179.235c-.017 31.594 8.242 62.432 23.928 89.609L0 361.736l95.024-24.925c26.179 14.285 55.659 21.805 85.655 21.814h.077c98.788 0 179.21-80.413 179.244-179.244.017-47.898-18.608-92.926-52.454-126.807v-.008Zm-126.79 275.788h-.06c-26.73-.008-52.952-7.194-75.831-20.765l-5.44-3.231-56.391 14.791 15.05-54.981-3.542-5.638c-14.912-23.721-22.793-51.139-22.776-79.286.035-82.14 66.867-148.973 149.051-148.973 39.793.017 77.198 15.53 105.328 43.695 28.131 28.157 43.61 65.596 43.593 105.398-.035 82.149-66.867 148.982-148.982 148.982v.008Z"
          />
        </svg>
      </div>
    </motion.div>
  );
}

function GradientMesh(): React.JSX.Element {
  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      <motion.div
        animate={{ x: [0, 100, 0], y: [0, -60, 0], scale: [1, 1.2, 1] }}
        transition={{ duration: 20, repeat: Infinity, ease: 'linear' }}
        className="absolute -left-[20%] -top-[20%] h-[80vh] w-[80vh] rounded-full opacity-[0.07]"
        style={{ background: 'radial-gradient(circle, #3d6b52 0%, transparent 70%)' }}
      />
      <motion.div
        animate={{ x: [0, -80, 0], y: [0, 40, 0], scale: [1, 1.1, 1] }}
        transition={{ duration: 25, repeat: Infinity, ease: 'linear' }}
        className="absolute -right-[10%] top-[20%] h-[60vh] w-[60vh] rounded-full opacity-[0.05]"
        style={{ background: 'radial-gradient(circle, #4d8a68 0%, transparent 70%)' }}
      />
      <motion.div
        animate={{ x: [0, 50, 0], y: [0, 80, 0], scale: [1, 0.9, 1] }}
        transition={{ duration: 18, repeat: Infinity, ease: 'linear' }}
        className="absolute bottom-[10%] left-[30%] h-[50vh] w-[50vh] rounded-full opacity-[0.04]"
        style={{ background: 'radial-gradient(circle, #22c55e 0%, transparent 70%)' }}
      />
      <WhatsAppBubble size={160} x="8%" y="15%" delay={0} duration={14} />
      <WhatsAppBubble size={100} x="75%" y="60%" delay={3} duration={18} />
      <WhatsAppBubble size={130} x="85%" y="25%" delay={1.5} duration={16} />
      <WhatsAppBubble size={80} x="15%" y="70%" delay={5} duration={20} />
      <WhatsAppBubble size={110} x="50%" y="85%" delay={2} duration={15} />
    </div>
  );
}

function Nav(): React.JSX.Element {
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', onScroll);
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const navLinks = [
    { label: 'Features', href: '#features' },
    { label: 'How it works', href: '#how-it-works' },
    { label: 'Pricing', href: '#pricing' },
  ];

  return (
    <motion.nav
      initial={{ y: -100 }}
      animate={{ y: 0 }}
      transition={{ duration: 0.8, ease: easeOutExpo }}
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-500 ${
        scrolled ? 'bg-[#0f0f0f]/80 backdrop-blur-xl border-b border-[#2a2a2a]/50' : 'bg-transparent'
      }`}
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
          onClick={() => navigate('/')} className="flex items-center gap-2 text-[#f0f0f0]">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-[#3d6b52] to-[#4d8a68]">
            <span className="text-xs font-bold text-white">FD</span>
          </div>
          <span className="text-lg font-semibold tracking-tight">Flowdesk</span>
        </motion.button>

        <div className="hidden items-center gap-8 md:flex">
          {navLinks.map((link) => (
            <motion.a key={link.href} href={link.href} whileHover={{ y: -2 }}
              className="text-sm font-medium text-[#888] transition-colors hover:text-[#f0f0f0]">
              {link.label}
            </motion.a>
          ))}
        </div>

        <div className="hidden items-center gap-3 md:flex">
          <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}
            onClick={() => navigate('/login')}
            className="rounded-lg px-4 py-2 text-sm font-medium text-[#888] transition-colors hover:text-[#f0f0f0]">
            Log in
          </motion.button>
          <motion.button
            whileHover={{ scale: 1.05, boxShadow: '0 0 20px rgba(61,107,82,0.4)' }}
            whileTap={{ scale: 0.95 }}
            onClick={() => navigate('/register')}
            className="rounded-lg bg-gradient-to-r from-[#3d6b52] to-[#4d8a68] px-4 py-2 text-sm font-medium text-white"
          >
            Start free trial
          </motion.button>
        </div>

        <button className="text-[#f0f0f0] md:hidden" onClick={() => setMobileOpen(!mobileOpen)}>
          {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {mobileOpen && (
        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
          className="border-b border-[#2a2a2a] bg-[#0f0f0f]/95 px-6 pb-6 md:hidden">
          <div className="flex flex-col gap-4 pt-2">
            {navLinks.map((link) => (
              <a key={link.href} href={link.href} onClick={() => setMobileOpen(false)}
                className="text-sm font-medium text-[#888] transition-colors hover:text-[#f0f0f0]">
                {link.label}
              </a>
            ))}
            <hr className="border-[#2a2a2a]" />
            <button onClick={() => { setMobileOpen(false); navigate('/login'); }}
              className="text-left text-sm font-medium text-[#888]">Log in</button>
            <button onClick={() => { setMobileOpen(false); navigate('/register'); }}
              className="rounded-lg bg-gradient-to-r from-[#3d6b52] to-[#4d8a68] px-4 py-2.5 text-sm font-medium text-white">
              Start free trial
            </button>
          </div>
        </motion.div>
      )}
    </motion.nav>
  );
}

function MockCard({ delay, children, className }: { delay: number; children: React.ReactNode; className?: string }): React.JSX.Element {
  return (
    <motion.div
      initial={{ opacity: 0, y: 60 }}
      animate={{ opacity: 1, y: [0, -12, 0] }}
      transition={{ opacity: { duration: 1, delay }, y: { duration: 5, delay, repeat: Infinity, ease: 'easeInOut' } }}
      className={`rounded-xl border border-[#2a2a2a] bg-[#161616]/80 backdrop-blur-sm p-4 shadow-2xl ${className ?? ''}`}
    >
      {children}
    </motion.div>
  );
}

function Hero(): React.JSX.Element {
  const navigate = useNavigate();
  const { scrollY } = useScroll();
  const y1 = useTransform(scrollY, [0, 500], [0, 150]);
  const y2 = useTransform(scrollY, [0, 500], [0, -100]);

  return (
    <section className="relative overflow-hidden px-6 pt-32 pb-20 md:pt-44 md:pb-28">
      <motion.div style={{ y: y1 }} className="absolute right-[5%] top-[15%] hidden lg:block">
        <MockCard delay={0.8} className="w-64">
          <div className="mb-3 flex items-center gap-2">
            <div className="h-2 w-2 rounded-full bg-[#22c55e]" />
            <span className="text-xs text-[#888]">New order from +233244123456</span>
          </div>
          <div className="space-y-2">
            <div className="h-2 w-3/4 rounded bg-[#2a2a2a]" />
            <div className="h-2 w-1/2 rounded bg-[#2a2a2a]" />
          </div>
          <div className="mt-3 flex gap-2">
            <span className="rounded bg-[rgba(61,107,82,0.2)] px-2 py-0.5 text-[10px] text-[#4d8a68]">2x Rice</span>
            <span className="rounded bg-[rgba(61,107,82,0.2)] px-2 py-0.5 text-[10px] text-[#4d8a68]">GHS 45</span>
          </div>
        </MockCard>
      </motion.div>

      <motion.div style={{ y: y2 }} className="absolute left-[5%] top-[30%] hidden lg:block">
        <MockCard delay={1.1} className="w-56">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs text-[#888]">Revenue today</span>
            <TrendingUp className="h-3 w-3 text-[#22c55e]" />
          </div>
          <div className="text-xl font-bold text-[#f0f0f0]">GHS 1,240</div>
          <div className="mt-1 h-8 w-full rounded bg-gradient-to-t from-[#3d6b52]/20 to-transparent" />
        </MockCard>
      </motion.div>

      <div className="relative mx-auto max-w-4xl text-center">
        <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.6 }}
          className="mb-6 inline-flex items-center gap-2 rounded-full border border-[#2a2a2a] bg-[#161616]/60 px-4 py-1.5 backdrop-blur-sm">
          <Sparkles className="h-3.5 w-3.5 text-[#4d8a68]" />
          <span className="text-xs font-medium text-[#888]">Now accepting early users</span>
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9, ease: easeOutExpo, delay: 0.15 }}
          className="mb-6 text-4xl font-bold leading-[1.1] tracking-tight text-[#f0f0f0] md:text-6xl lg:text-7xl"
        >
          Track orders from your{' '}
          <span className="bg-gradient-to-r from-[#4d8a68] to-[#22c55e] bg-clip-text text-transparent">
            WhatsApp
          </span>{' '}
          chats
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9, ease: easeOutExpo, delay: 0.3 }}
          className="mx-auto mb-10 max-w-2xl text-lg leading-relaxed text-[#888]"
        >
          When customers message you about orders, Flowdesk captures the details,
          tracks payments, and keeps your product catalog in one place.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: easeOutExpo, delay: 0.5 }}
          className="flex flex-col items-center justify-center gap-3 sm:flex-row"
        >
          <motion.button
            whileHover={{ scale: 1.05, boxShadow: '0 0 30px rgba(61,107,82,0.5)' }}
            whileTap={{ scale: 0.95 }}
            onClick={() => navigate('/register')}
            className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-[#3d6b52] to-[#4d8a68] px-7 py-3.5 text-sm font-semibold text-white"
          >
            Try it free for 14 days <ArrowRight className="h-4 w-4" />
          </motion.button>
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => navigate('/login')}
            className="rounded-xl border border-[#2a2a2a] px-7 py-3.5 text-sm font-semibold text-[#f0f0f0] transition-colors hover:bg-[#161616]/60"
          >
            Log in to your account
          </motion.button>
        </motion.div>
      </div>
    </section>
  );
}

const features = [
  { icon: MessageSquare, title: 'WhatsApp inbox', description: 'Connect your WhatsApp Business number. Every message comes into a clean dashboard where you can see and sort them.' },
  { icon: ShoppingCart, title: 'Order tracking', description: 'When customers place orders in chat, Flowdesk captures the items, quantities, and prices into a structured order.' },
  { icon: Wallet, title: 'Payments', description: 'Record mobile money, bank transfers, and cash. Match payments to orders and send receipts back on WhatsApp.' },
  { icon: BarChart3, title: 'Dashboard', description: 'See orders, revenue, stock alerts, and unread messages in one screen. No more switching between apps.' },
  { icon: Users, title: 'Customers', description: 'Each person who messages you gets a profile with their chat history, orders, and payments. You always know who you are talking to.' },
  { icon: Zap, title: 'Quick replies', description: 'Set up message templates for order confirmations, delivery updates, and greetings. Send them with one click.' },
];

const containerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.1, delayChildren: 0.2 } },
};

const itemVariants = {
  hidden: { opacity: 0, y: 40, scale: 0.95 },
  visible: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.7, ease: easeOutExpo } },
};

function FeatureCard({ feature }: { feature: typeof features[0] }): React.JSX.Element {
  return (
    <motion.div
      variants={itemVariants}
      whileHover={{ y: -10, rotateX: 5, rotateY: 5, transition: { duration: 0.3 } }}
      style={{ transformStyle: 'preserve-3d', perspective: 1000 }}
      className="group relative rounded-2xl border border-[#2a2a2a] bg-[#161616]/80 p-6 backdrop-blur-sm transition-colors hover:border-[#3d6b52]/50"
    >
      <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-[#3d6b52]/5 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
      <div className="relative">
        <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-[rgba(61,107,82,0.15)] to-[rgba(61,107,82,0.05)]">
          <feature.icon className="h-5 w-5 text-[#4d8a68]" />
        </div>
        <h3 className="mb-2 text-base font-semibold text-[#f0f0f0]">{feature.title}</h3>
        <p className="text-sm leading-relaxed text-[#888]">{feature.description}</p>
      </div>
    </motion.div>
  );
}

function Features(): React.JSX.Element {
  return (
    <section id="features" className="relative px-6 py-24">
      <div className="mx-auto max-w-6xl">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-100px' }}
          transition={{ duration: 0.8, ease: easeOutExpo }}
          className="mb-16 text-center"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
            className="mb-4 inline-flex items-center gap-2 rounded-full border border-[#2a2a2a] bg-[#161616]/60 px-4 py-1"
          >
            <span className="text-xs font-medium text-[#888]">Features</span>
          </motion.div>
          <h2 className="mb-4 text-3xl font-bold text-[#f0f0f0] md:text-5xl">
            What you get with Flowdesk
          </h2>
          <p className="mx-auto max-w-xl text-[#888]">
            Six tools that replace the notebook, spreadsheet, and mental math you are using now.
          </p>
        </motion.div>

        <motion.div
          variants={containerVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: '-50px' }}
          className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
        >
          {features.map((f) => (
            <FeatureCard key={f.title} feature={f} />
          ))}
        </motion.div>
      </div>
    </section>
  );
}

function HowItWorks(): React.JSX.Element {
  const steps = [
    { num: '01', title: 'Connect WhatsApp', desc: 'Link your WhatsApp Business number. It takes about two minutes.', color: '#3d6b52' },
    { num: '02', title: 'Receive messages', desc: 'Customers message you like they always do. Flowdesk pulls every message into your dashboard.', color: '#4d8a68' },
    { num: '03', title: 'Review & confirm', desc: 'Orders show up on your screen. Confirm them, assign staff, and track what is ready for delivery.', color: '#22c55e' },
    { num: '04', title: 'Record payments', desc: 'When someone pays, mark it in Flowdesk. Receipts go straight back to their WhatsApp.', color: '#3d6b52' },
  ];

  return (
    <section id="how-it-works" className="relative px-6 py-24">
      <div className="mx-auto max-w-4xl">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-100px' }}
          transition={{ duration: 0.8, ease: easeOutExpo }}
          className="mb-16 text-center"
        >
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-[#2a2a2a] bg-[#161616]/60 px-4 py-1">
            <span className="text-xs font-medium text-[#888]">How it works</span>
          </div>
          <h2 className="mb-4 text-3xl font-bold text-[#f0f0f0] md:text-5xl">How it works</h2>
          <p className="text-[#888]">Four steps. No more writing orders in a notebook.</p>
        </motion.div>

        <div className="relative">
          <div className="absolute left-[27px] top-0 h-full w-px bg-gradient-to-b from-[#3d6b52]/40 via-[#4d8a68]/40 to-transparent md:left-[31px]" />
          <div className="space-y-10">
            {steps.map((s, i) => (
              <motion.div
                key={s.num}
                initial={{ opacity: 0, x: -30 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true, margin: '-50px' }}
                transition={{ duration: 0.7, ease: easeOutExpo, delay: i * 0.15 }}
                className="flex items-start gap-5 md:items-center"
              >
                <motion.div
                  whileHover={{ scale: 1.15, rotate: 5 }}
                  className="relative flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-[#2a2a2a] bg-[#161616] shadow-lg"
                  style={{ boxShadow: `0 0 20px ${s.color}20` }}
                >
                  <span className="text-sm font-bold" style={{ color: s.color }}>{s.num}</span>
                </motion.div>
                <div className="rounded-xl border border-[#2a2a2a] bg-[#161616]/60 p-5 backdrop-blur-sm transition-colors hover:border-[#3d6b52]/30 md:flex-1">
                  <h3 className="mb-1 text-base font-semibold text-[#f0f0f0]">{s.title}</h3>
                  <p className="text-sm text-[#888]">{s.desc}</p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function Pricing(): React.JSX.Element {
  const navigate = useNavigate();

  const plans = [
    { name: 'Starter', price: 'Free', period: 'for 14 days', description: 'Perfect for solo sellers testing the waters.', features: ['Up to 500 conversations / month', 'Up to 300 orders / month', '1 staff member', '50 products', 'Basic auto-replies'], highlighted: false },
    { name: 'Business', price: 'GHS 149', period: '/ month', description: 'For growing shops with multiple staff.', features: ['Up to 2,000 conversations / month', 'Unlimited orders', '5 staff members', 'Unlimited products', 'Custom auto-reply templates', 'Priority support'], highlighted: true },
    { name: 'Growth', price: 'GHS 399', period: '/ month', description: 'For established brands scaling fast.', features: ['Up to 10,000 conversations / month', 'Unlimited orders', '20 staff members', 'Unlimited products', 'Advanced analytics', 'Dedicated support'], highlighted: false },
  ];

  return (
    <section id="pricing" className="relative px-6 py-24">
      <div className="mx-auto max-w-6xl">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-100px' }}
          transition={{ duration: 0.8, ease: easeOutExpo }}
          className="mb-16 text-center"
        >
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-[#2a2a2a] bg-[#161616]/60 px-4 py-1">
            <span className="text-xs font-medium text-[#888]">Pricing</span>
          </div>
          <h2 className="mb-4 text-3xl font-bold text-[#f0f0f0] md:text-5xl">Simple pricing</h2>
          <p className="text-[#888]">Start free. Upgrade when you grow.</p>
        </motion.div>

        <motion.div
          variants={containerVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: '-50px' }}
          className="grid gap-6 md:grid-cols-3"
        >
          {plans.map((plan) => (
            <motion.div
              key={plan.name}
              variants={itemVariants}
              whileHover={{ y: -12, transition: { duration: 0.3 } }}
              className={`relative rounded-2xl border p-7 backdrop-blur-sm ${
                plan.highlighted
                  ? 'border-[#3d6b52]/60 bg-[#161616]/90 shadow-[0_0_40px_rgba(61,107,82,0.15)]'
                  : 'border-[#2a2a2a] bg-[#161616]/60'
              }`}
            >
              {plan.highlighted && (
                <span className="absolute -top-3 left-6 animate-pulse rounded-full bg-gradient-to-r from-[#3d6b52] to-[#4d8a68] px-3 py-0.5 text-xs font-semibold text-white shadow-[0_0_15px_rgba(61,107,82,0.4)]">
                  Most popular
                </span>
              )}
              <h3 className="mb-1 text-lg font-semibold text-[#f0f0f0]">{plan.name}</h3>
              <p className="mb-5 text-sm text-[#888]">{plan.description}</p>
              <div className="mb-6">
                <span className={`text-4xl font-bold ${plan.highlighted ? 'bg-gradient-to-r from-[#4d8a68] to-[#22c55e] bg-clip-text text-transparent' : 'text-[#f0f0f0]'}`}>{plan.price}</span>
                <span className="text-sm text-[#888]"> {plan.period}</span>
              </div>
              <ul className="mb-7 space-y-3">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm text-[#888]">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-[#4d8a68]" />
                    {f}
                  </li>
                ))}
              </ul>
              <motion.button
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
                onClick={() => navigate('/register')}
                className={`w-full rounded-xl py-2.5 text-sm font-semibold transition-colors ${
                  plan.highlighted
                    ? 'bg-gradient-to-r from-[#3d6b52] to-[#4d8a68] text-white hover:shadow-[0_0_20px_rgba(61,107,82,0.4)]'
                    : 'border border-[#2a2a2a] text-[#f0f0f0] hover:bg-[#1e1e1e]'
                }`}
              >
                Start free trial
              </motion.button>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}

function CTA(): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <section className="relative px-6 py-24">
      <motion.div
        initial={{ opacity: 0, y: 40, scale: 0.95 }}
        whileInView={{ opacity: 1, y: 0, scale: 1 }}
        viewport={{ once: true, margin: '-100px' }}
        transition={{ duration: 0.9, ease: easeOutExpo }}
        className="relative mx-auto max-w-4xl overflow-hidden rounded-3xl border border-[#2a2a2a] bg-gradient-to-br from-[#161616] to-[#0f0f0f] p-10 text-center md:p-16"
      >
        <div className="absolute inset-0 opacity-30" style={{ background: 'radial-gradient(circle at 50% 0%, rgba(61,107,82,0.15), transparent 60%)' }} />
        <div className="relative">
          <h2 className="mb-4 text-3xl font-bold text-[#f0f0f0] md:text-5xl">
            Stop losing orders in your chat history
          </h2>
          <p className="mx-auto mb-8 max-w-lg text-[#888]">
            Flowdesk keeps your orders, payments, and customer details in one place. Try it free for 14 days.
          </p>
          <motion.button
            whileHover={{ scale: 1.05, boxShadow: '0 0 40px rgba(61,107,82,0.5)' }}
            whileTap={{ scale: 0.95 }}
            onClick={() => navigate('/register')}
            className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-[#3d6b52] to-[#4d8a68] px-8 py-4 text-sm font-semibold text-white"
          >
            Create your account <ArrowRight className="h-4 w-4" />
          </motion.button>
        </div>
      </motion.div>
    </section>
  );
}

function Footer(): React.JSX.Element {
  return (
    <motion.footer
      initial={{ opacity: 0 }}
      whileInView={{ opacity: 1 }}
      viewport={{ once: true }}
      transition={{ duration: 0.8 }}
      className="border-t border-[#2a2a2a] px-6 py-12"
    >
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 md:flex-row">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-[#3d6b52] to-[#4d8a68]">
            <span className="text-[10px] font-bold text-white">FD</span>
          </div>
          <span className="text-sm font-semibold text-[#f0f0f0]">Flowdesk</span>
        </div>
        <p className="text-xs text-[#555]">
          &copy; {new Date().getFullYear()} Flowdesk
        </p>
      </div>
    </motion.footer>
  );
}

export default function LandingPage(): React.JSX.Element {
  return (
    <div className="relative min-h-screen bg-[#0f0f0f]">
      <GradientMesh />
      <Nav />
      <Hero />
      <Features />
      <HowItWorks />
      <Pricing />
      <CTA />
      <Footer />
    </div>
  );
}
