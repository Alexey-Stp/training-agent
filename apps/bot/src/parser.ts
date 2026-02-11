export interface ParsedCommand {
  commandName: string;
  args: string[];
}

export function parseCommand(text: string): ParsedCommand {
  const trimmed = text.trim();

  // Handle commands that start with /
  if (trimmed.startsWith('/')) {
    const parts = trimmed.slice(1).split(/\s+/);
    const commandName = parts[0].toLowerCase();
    const args = parts.slice(1);
    return { commandName, args };
  }

  // Any other text is treated as unknown command
  return {
    commandName: 'unknown',
    args: [trimmed],
  };
}

export function validateSetFtpArgs(args: string[]): { valid: boolean; ftp?: number; error?: string } {
  if (args.length < 2) {
    return { valid: false, error: 'Usage: /set ftp <number>' };
  }

  if (args[0].toLowerCase() !== 'ftp') {
    return { valid: false, error: 'Currently only /set ftp is supported' };
  }

  const ftp = parseInt(args[1], 10);
  if (isNaN(ftp) || ftp < 50 || ftp > 600) {
    return { valid: false, error: 'FTP must be a number between 50 and 600' };
  }

  return { valid: true, ftp };
}

export function validateLogArgs(args: string[]): {
  valid: boolean;
  sport?: string;
  durationMin?: number;
  intensity?: string;
  error?: string;
} {
  if (args.length < 2) {
    return { valid: false, error: 'Usage: /log <sport> <durationMin> [intensity]\nSport: swim|bike|run' };
  }

  const sport = args[0].toLowerCase();
  const validSports = ['swim', 'bike', 'run'];
  if (!validSports.includes(sport)) {
    return { valid: false, error: `Sport must be one of: ${validSports.join(', ')}` };
  }

  const durationMin = parseInt(args[1], 10);
  if (isNaN(durationMin) || durationMin < 1 || durationMin > 1440) {
    return { valid: false, error: 'Duration must be a number between 1 and 1440 minutes' };
  }

  let intensity: string | undefined;
  if (args.length >= 3) {
    intensity = args[2].toLowerCase();
    const validIntensities = ['z1', 'z2', 'z3', 'z4', 'z5'];
    if (!validIntensities.includes(intensity)) {
      return { valid: false, error: `Intensity must be one of: ${validIntensities.join(', ')}` };
    }
  }

  return { valid: true, sport, durationMin, intensity };
}
