import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-neutral-800 text-neutral-100',
        live: 'border-transparent bg-emerald-500/20 text-emerald-300',
        locked: 'border-transparent bg-amber-500/20 text-amber-300',
        resolved: 'border-transparent bg-sky-500/20 text-sky-300',
        refunded: 'border-transparent bg-neutral-700/40 text-neutral-400',
        outline: 'border-neutral-700 text-neutral-300',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
