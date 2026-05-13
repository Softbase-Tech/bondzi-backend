import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Versioned AI prompt templates stored in DB rather than hardcoded. Changing a
 * prompt is a database update, not a deploy (spec §6.1 "Prompt layer"). Only
 * one active version per (name) is served at a time.
 */
@Entity({ name: 'prompt_templates' })
@Index('prompt_templates_name_version_uq', ['name', 'version'], {
  unique: true,
})
@Index('prompt_templates_active_uq', ['name'], {
  unique: true,
  where: '"is_active" = true',
})
export class PromptTemplate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'text' })
  version: string;

  @Column({ type: 'text' })
  content: string;

  @Column({ name: 'is_active', type: 'bool', default: true })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
