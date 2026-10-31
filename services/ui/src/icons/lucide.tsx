// The Lucide option: Lucide for every glyph, Simple Icons paths for brand marks.
import { Star, type LucideProps } from "lucide-react";
import { SiGithub } from "react-icons/si";
import { FaSlack } from "react-icons/fa";

export * from "lucide-react";

export const StarFilled = (p: LucideProps) => <Star fill="currentColor" {...p} />;
export const GithubMark = SiGithub;
export const SlackMark = FaSlack;

/** Lucide has no scooter, so this one is drawn on Lucide's 24px stroke grid. */
export const ScooterMark = ({ className, style, ...p }: LucideProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    width={24}
    height={24}
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    style={style}
    {...(p as object)}
  >
    <circle cx="5" cy="18" r="2" />
    <circle cx="19" cy="18" r="2" />
    <path d="M7 18h10" />
    <path d="M19 18 16 5" />
    <path d="M13.5 5H18" />
  </svg>
);
