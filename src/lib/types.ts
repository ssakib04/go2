export type Profile = {
  id: string;
  google_id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  drive_linked: boolean;
  created_at: string;
};

export type Room = {
  id: string;
  host_id: string;
  room_name: string;
  max_photo_limit: number;
  current_photo_count: number;
  is_active: boolean;
  created_at: string;
};

export type RoomMember = {
  id: string;
  user_id: string;
  photos_uploaded: number;
  joined_at: string;
  full_name: string | null;
  email: string;
  avatar_url: string | null;
};

export type PhotoMeta = {
  id: string;
  file_name: string;
  uploaded_at: string;
  uploader_id: string;
};
