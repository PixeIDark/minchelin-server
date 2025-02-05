import { Injectable, Inject, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

@Injectable()
export class FavoritesService {
  constructor(
    @Inject('DATABASE_CONNECTION')
    private connection: Pool,
  ) {
  }

  async getFavoriteLists(userId: number) {
    const [lists] = await this.connection.execute<RowDataPacket[]>(
      'SELECT * FROM favorite_lists WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC',
      [userId],
    );
    return lists;
  }

  async getFavoriteListSongs(userId: number, listId: number) {
    await this.validateListOwnership(userId, listId);

    const [songs] = await this.connection.execute<RowDataPacket[]>(
      `SELECT 
        fs.id as favorite_id,
        fs.song_id,
        fs.order,
        s.title_ko,
        s.title_ja,
        s.title_en,
        s.thumbnail_url
      FROM favorite_songs fs
      INNER JOIN songs s ON fs.song_id = s.id
      WHERE fs.list_id = ?
      ORDER BY fs.order ASC`,
      [listId],
    );

    return songs;
  }

  async createFavoriteList(userId: number, name: string) {
    const [result] = await this.connection.execute<ResultSetHeader>(
      'INSERT INTO favorite_lists (user_id, name) VALUES (?, ?)',
      [userId, name],
    );
    return { id: result.insertId, name };
  }

  async updateFavoriteList(userId: number, listId: number, name: string) {
    await this.validateListOwnership(userId, listId);

    await this.connection.execute(
      'UPDATE favorite_lists SET name = ? WHERE id = ?',
      [name, listId],
    );

    return { id: listId, name };
  }

  async deleteFavoriteList(userId: number, listId: number) {
    await this.validateListOwnership(userId, listId);

    await this.connection.execute(
      'UPDATE favorite_lists SET deleted_at = NOW() WHERE id = ?',
      [listId],
    );

    return { message: '즐겨찾기 목록이 삭제되었습니다.' };
  }

  async addSongToList(userId: number, listId: number, songId: number) {
    await this.validateListOwnership(userId, listId);

    // 중복 체크
    const [existingSongs] = await this.connection.execute<RowDataPacket[]>(
      'SELECT id FROM favorite_songs WHERE list_id = ? AND song_id = ?',
      [listId, songId],
    );

    if (existingSongs.length > 0) {
      throw new BadRequestException('이미 즐겨찾기 목록에 존재하는 곡입니다.');
    }

    const [maxOrderResult] = await this.connection.execute<RowDataPacket[]>(
      'SELECT COALESCE(MAX(`order`), 0) as maxOrder FROM favorite_songs WHERE list_id = ?',
      [listId],
    );
    const maxOrder = maxOrderResult[0].maxOrder;

    const [result] = await this.connection.execute<ResultSetHeader>(
      'INSERT INTO favorite_songs (list_id, song_id, `order`) VALUES (?, ?, ?)',
      [listId, songId, maxOrder + 1],
    );

    return {
      favorite_id: result.insertId,
      message: '곡이 즐겨찾기에 추가되었습니다.',
    };
  }

  async removeSongFromList(userId: number, favoriteId: number) {
    const connection = await this.connection.getConnection();

    try {
      // favorite_id로 list_id를 찾고, 권한 확인
      const [favoriteRows] = await connection.execute<RowDataPacket[]>(
        `SELECT fs.list_id, fs.order
         FROM favorite_songs fs
         INNER JOIN favorite_lists fl ON fs.list_id = fl.id
         WHERE fs.id = ? AND fl.user_id = ? AND fl.deleted_at IS NULL`,
        [favoriteId, userId],
      );

      if (!favoriteRows[0]) {
        throw new ForbiddenException('해당 즐겨찾기 항목에 대한 권한이 없습니다.');
      }

      const { list_id, order } = favoriteRows[0];

      // 트랜잭션 시작
      await connection.beginTransaction();

      try {
        // 항목 삭제
        await connection.execute(
          'DELETE FROM favorite_songs WHERE id = ?',
          [favoriteId],
        );

        // 뒤따르는 항목들의 order 값 감소
        await connection.execute(
          'UPDATE favorite_songs SET `order` = `order` - 1 WHERE list_id = ? AND `order` > ?',
          [list_id, order],
        );

        await connection.commit();
        return { message: '곡이 즐겨찾기에서 제거되었습니다.' };
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    } finally {
      connection.release();
    }
  }

  async reorderSong(userId: number, favoriteId: number, newOrder: number) {
    const connection = await this.connection.getConnection();

    try {
      // favorite_id로 현재 order와 list_id를 찾고, 권한 확인
      const [favorites] = await connection.execute<RowDataPacket[]>(
        `SELECT fs.id, fs.list_id, fs.order
         FROM favorite_songs fs
         INNER JOIN favorite_lists fl ON fs.list_id = fl.id
         WHERE fs.id = ? AND fl.user_id = ? AND fl.deleted_at IS NULL`,
        [favoriteId, userId],
      );

      if (!favorites[0]) {
        throw new ForbiddenException('해당 즐겨찾기 항목에 대한 권한이 없습니다.');
      }

      const { list_id, order: currentOrder } = favorites[0];

      // 최대 order 값 확인
      const [maxOrderResult] = await connection.execute<RowDataPacket[]>(
        'SELECT COUNT(*) as maxOrder FROM favorite_songs WHERE list_id = ?',
        [list_id],
      );

      const maxOrder = maxOrderResult[0].maxOrder;

      // newOrder가 범위를 벗어나지 않도록 보정
      const targetOrder = Math.max(1, Math.min(newOrder, maxOrder));

      // 트랜잭션 시작
      await connection.beginTransaction();

      try {
        if (currentOrder < targetOrder) {
          // 위에서 아래로 이동: currentOrder와 targetOrder 사이의 항목들을 한 칸씩 위로
          await connection.execute(
            `UPDATE favorite_songs 
             SET \`order\` = \`order\` - 1 
             WHERE list_id = ? 
             AND \`order\` > ? 
             AND \`order\` <= ?`,
            [list_id, currentOrder, targetOrder],
          );
        } else if (currentOrder > targetOrder) {
          // 아래에서 위로 이동: targetOrder와 currentOrder 사이의 항목들을 한 칸씩 아래로
          await connection.execute(
            `UPDATE favorite_songs 
             SET \`order\` = \`order\` + 1 
             WHERE list_id = ? 
             AND \`order\` >= ? 
             AND \`order\` < ?`,
            [list_id, targetOrder, currentOrder],
          );
        }

        // 드래그한 항목을 새 위치로 이동
        await connection.execute(
          'UPDATE favorite_songs SET `order` = ? WHERE id = ?',
          [targetOrder, favoriteId],
        );

        await connection.commit();
        return { message: '곡 순서가 변경되었습니다.' };
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    } finally {
      connection.release();
    }
  }

  private async validateListOwnership(userId: number, listId: number) {
    const [lists] = await this.connection.execute<RowDataPacket[]>(
      'SELECT id FROM favorite_lists WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
      [listId, userId],
    );

    if (!lists[0]) {
      throw new ForbiddenException('해당 즐겨찾기 목록에 대한 권한이 없습니다.');
    }
  }
}